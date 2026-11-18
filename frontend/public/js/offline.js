import { request } from './api.js';

const dbName = 'interruptions.offline.v1';
const stores = ['entities', 'outbox', 'meta'];
const metaKey = 'sync';
const legacyPrefix = 'interruptions.draft.v1.';
const entryFields = ['source_name', 'kind', 'note', 'involvement_reason', 'estimated'];
const noteFields = ['planned_minutes', 'available_minutes', 'outcomes_note', 'coverage'];
const settingsFields = ['timezone', 'pinned_actions', 'analysis_context'];

const entityKey = (kind, id) => `${kind}:${id}`;
const entryKey = id => entityKey('entry', id);
const absent = () => ({ cursor: 0, ready: false, serverNow: null, lastSync: null, restoredDrafts: [] });
const select = (source, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(source, field)).map(field => [field, source[field]]));

function resultOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(db, names, mode, work) {
  const tx = db.transaction(names, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error('Запись на устройстве отменена'));
  });
  return Promise.resolve().then(() => work(...names.map(name => tx.objectStore(name)))).then(async result => {
    await done;
    return result;
  }, async error => {
    try { tx.abort(); } catch { /* The transaction already ended. */ }
    await done.catch(() => {});
    throw error;
  });
}

function openDatabase(name) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('entities', { keyPath: 'key' });
    db.createObjectStore('outbox', { keyPath: 'position', autoIncrement: true });
    db.createObjectStore('meta');
  };
  return resultOf(request);
}

function entryPatch(payload) {
  const fields = select(payload, entryFields);
  if (Object.hasOwn(fields, 'kind')) fields.kind ||= 'unknown';
  return fields;
}

function newEntry(payload) {
  const mode = payload.mode ?? 'timer';
  return {
    id: payload.id, started_at: payload.started_at, ended_at: payload.ended_at ?? null,
    source_name: null, kind: 'unknown', note: null, involvement_reason: null,
    estimated: mode === 'manual', mode, capture_mode: mode, revision: 1,
    ...entryPatch(payload),
  };
}

function operationTarget({ type, payload }) {
  if (type === 'settings.patch') return entityKey('settings', 1);
  if (type === 'day_note.put') return entityKey('day_note', payload.date);
  if (type === 'entry.switch') return entryKey(payload.expected_id);
  return entryKey(payload.id);
}

function affectedKeys(operation) {
  const keys = [operationTarget(operation)];
  if (operation.type === 'entry.switch') keys.push(entryKey(operation.payload.new_entry_id));
  return keys;
}

function revisionAfter(operation, key) {
  const { type, payload } = operation;
  if (type === 'entry.delete') return null;
  if (type === 'entry.create' || (type === 'entry.switch' && key === entryKey(payload.new_entry_id))) return 1;
  return payload.expected_revision + 1;
}

function project(rows, queue) {
  const view = new Map(rows.filter(row => row.value !== null).map(row => [row.key, row.value]));
  let localActive = null;
  for (const operation of queue) {
    const { type, payload } = operation;
    const key = operationTarget(operation);
    const current = view.get(key) ?? operation.before;
    const revision = revisionAfter(operation, key);
    switch (type) {
      case 'entry.create': {
        const entry = newEntry(payload);
        view.set(key, entry);
        if (entry.ended_at === null) localActive = key;
        break;
      }
      case 'entry.update':
        if (current) view.set(key, { ...current, ...entryPatch(payload), ...select(payload, ['started_at', 'ended_at']), revision });
        break;
      case 'entry.delete':
        view.delete(key);
        break;
      case 'entry.finish':
      case 'entry.switch': {
        const end = type === 'entry.finish' ? payload.clicked_ended_at : payload.switch_at;
        const adjustedEnd = current && end < current.started_at && current.started_at - end <= 2000 ? current.started_at : end;
        if (current) {
          view.set(key, {
            ...current, ...entryPatch(payload.final_patch ?? payload.closing_patch ?? {}), ended_at: adjustedEnd, revision,
            ...(adjustedEnd !== end ? { estimated: true } : {}),
          });
        }
        if (type === 'entry.switch') {
          localActive = entryKey(payload.new_entry_id);
          view.set(localActive, newEntry({ ...payload.preset, id: payload.new_entry_id, started_at: adjustedEnd, ...(adjustedEnd !== end ? { estimated: true } : {}) }));
        }
        break;
      }
      case 'day_note.put':
        view.set(key, { date: payload.date, planned_minutes: null, available_minutes: null, outcomes_note: null, coverage: 'unknown', ...select(payload, noteFields), revision });
        break;
      case 'settings.patch':
        if (current) view.set(key, { ...current, ...select(payload, settingsFields), revision });
        break;
    }
  }
  const remoteActive = rows.find(row => row.kind === 'entry' && row.value?.ended_at === null);
  const local = view.get(localActive);
  const remote = view.get(remoteActive?.key);
  const active = local?.ended_at === null ? local : remote?.ended_at === null ? remote : null;
  return { view, active };
}

function listByKind(view, kind) {
  return [...view].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value);
}

function problem(error) {
  return {
    status: error.status ?? 0,
    code: error.payload?.error?.code ?? 'SYNC_UNAVAILABLE',
    message: error.message || 'Не удалось синхронизировать журнал',
  };
}

function canRebase(operation, remote) {
  if (operation.failure?.error.status !== 409 || operation.type === 'entry.create') return false;
  if (operation.type === 'day_note.put') return true;
  if (!remote) return false;
  if (operation.type === 'entry.switch') return remote.ended_at === null;
  if (operation.type === 'entry.finish') return operation.payload.clicked_ended_at + 2000 >= remote.started_at;
  return true;
}

function canClose(operation, remote, next) {
  if (operation.type === 'entry.create') return !remote && operation.failure?.error.code === 'ACTIVE_ENTRY_EXISTS';
  return operation.type === 'entry.switch' && operation.failure?.error.status === 409 && !next;
}

function newOperation(type, payload, view, queue) {
  const operation = { operation_id: crypto.randomUUID(), type, payload, attempted: false };
  const key = operationTarget(operation);
  operation.before = view.get(key) ?? null;
  const prior = queue.findLast(item => affectedKeys(item).includes(key));
  if (prior && payload.expected_revision === revisionAfter(prior, key)) operation.dependsOn = prior.operation_id;
  return operation;
}

function closedPayload(payload, end, patch = {}) {
  const adjustedEnd = end < payload.started_at && payload.started_at - end <= 2000 ? payload.started_at : end;
  return { ...payload, ...entryPatch(patch), ended_at: adjustedEnd, ...(adjustedEnd !== end ? { estimated: true } : {}) };
}

// A queued start can be edited until it has ever been sent. This permits a complete
// offline timer interval to reach a server that already has a different active timer.
function coalesce(operation, queue, outbox) {
  const { type, payload } = operation;
  if (!['entry.finish', 'entry.update', 'entry.delete'].includes(type) || !operation.dependsOn) return false;
  const start = queue.find(item => item.operation_id === operation.dependsOn);
  if (start.type !== 'entry.create' || start.attempted) return false;
  if (type === 'entry.delete') {
    outbox.delete(start.position);
    return true;
  }
  if (start.payload.ended_at != null) return false;
  const next = type === 'entry.finish'
    ? closedPayload(start.payload, payload.clicked_ended_at, payload.final_patch)
    : { ...start.payload, ...entryPatch(payload), ...select(payload, ['started_at']) };
  outbox.put({ ...start, payload: next });
  return true;
}

async function mergeChanges(entities, changes) {
  await Promise.all(changes.map(async change => {
    const key = entityKey(change.kind, change.id);
    const previous = await resultOf(entities.get(key));
    if (!previous || change.seq > previous.seq) entities.put({ ...change, key });
  }));
}

function wire({ operation_id, type, payload }) {
  return { operation_id, type, payload };
}

function syncRequest(path, options) {
  return request(path, { ...options, signal: AbortSignal.timeout?.(20_000) });
}

// Only dependent actions inherit a rebase. A second form saved with an old revision
// still produces a conflict even if another queued action changed the same entity.
function rebaseDependents(outbox, queue, original, replacement, cloud) {
  const rebound = new Map();
  const record = (before, after) => {
    const results = new Map();
    for (const key of affectedKeys(before)) {
      if (after && affectedKeys(after).includes(key)) results.set(key, { revision: revisionAfter(after, key), dependsOn: after.operation_id });
      else results.set(key, { revision: cloud.get(key)?.revision ?? null });
    }
    rebound.set(before.operation_id, results);
  };
  record(original, replacement);
  for (const queued of queue) {
    if (queued.position <= original.position || queued.attempted) continue;
    const key = operationTarget(queued);
    const next = rebound.get(queued.dependsOn)?.get(key);
    if (next?.revision == null) continue;
    const payload = { ...queued.payload, expected_revision: next.revision };
    const operation = { ...queued, payload, dependsOn: next.dependsOn };
    outbox.put(operation);
    record(queued, operation);
  }
}

export class OfflineStore {
  constructor(onChange = () => {}, { database = dbName } = {}) {
    this.onChange = onChange;
    this.database = database;
    this.state = { ready: false, entries: [], notes: [], settings: null, reports: [], active: null, pending: 0, conflict: null, syncing: false, error: null, serverNow: null, lastSync: null };
    this.refreshNumber = 0;
    this.syncing = null;
  }

  async open() {
    this.db = await openDatabase(this.database);
    if (globalThis.BroadcastChannel) {
      this.channel = new BroadcastChannel(this.database);
      this.channel.onmessage = () => this.refresh().catch(error => this.publish({ error: problem(error) }));
    }
    await this.refresh();
  }

  close() {
    this.channel?.close();
    this.channel = null;
    this.db?.close();
  }

  publish(fields) {
    this.state = { ...this.state, ...fields };
    this.onChange(this.state);
  }

  async refresh() {
    if (!this.db) return;
    const refresh = ++this.refreshNumber;
    const [rows, queue, meta = absent()] = await transaction(this.db, stores, 'readonly', (entities, outbox, dbMeta) =>
      Promise.all([resultOf(entities.getAll()), resultOf(outbox.getAll()), resultOf(dbMeta.get(metaKey))]));
    if (refresh !== this.refreshNumber) return;
    const { view, active } = project(rows, queue);
    const entries = listByKind(view, 'entry').sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id));
    const operation = queue[0];
    let conflict = null;
    if (operation?.failure) {
      const confirmed = new Map(rows.map(row => [row.key, row]));
      const key = operationTarget(operation);
      const remote = confirmed.get(key)?.value;
      const changes = operation.failure.changes.map(change => confirmed.get(entityKey(change.kind, change.id)) ?? change);
      conflict = {
        operation: wire(operation), error: operation.failure.error, changes,
        local: affectedKeys(operation).map(target => view.get(target) ?? null),
        canUseLocal: canRebase(operation, remote),
        canSaveClosed: canClose(operation, remote, confirmed.get(entryKey(operation.payload.new_entry_id))?.value),
      };
    }
    this.publish({
      ready: meta.ready, entries, active, pending: queue.length, conflict,
      notes: listByKind(view, 'day_note'), reports: listByKind(view, 'report'),
      settings: meta.ready ? view.get(entityKey('settings', 1)) ?? null : null,
      serverNow: meta.serverNow, lastSync: meta.lastSync,
      viewKey: JSON.stringify([meta.ready, meta.cursor, conflict?.changes.map(change => change.seq),
        queue.map(operation => [operation.operation_id, operation.payload])]),
    });
  }

  async changed() {
    this.channel?.postMessage('changed');
    await this.refresh();
  }

  async enqueue(type, supplied) {
    const payload = { ...supplied };
    const operationId = await transaction(this.db, stores, 'readwrite', async (entities, outbox, dbMeta) => {
      const [rows, queue, meta] = await Promise.all([resultOf(entities.getAll()), resultOf(outbox.getAll()), resultOf(dbMeta.get(metaKey))]);
      if (!meta?.ready) throw new Error('Сначала загрузите журнал через интернет');
      const { view, active } = project(rows, queue);
      if (type === 'entry.create' && payload.ended_at == null && active) throw new Error('Уже есть активное обращение');
      const operation = newOperation(type, payload, view, queue);
      if (coalesce(operation, queue, outbox)) return operation.dependsOn;
      await resultOf(outbox.add(operation));
      return operation.operation_id;
    });
    await this.changed();
    this.scheduleSync();
    return operationId;
  }

  scheduleSync() {
    if (this.syncing) this.syncAgain = true;
    else void this.sync();
  }

  sync() {
    if (!this.db) return Promise.resolve(false);
    if (this.syncing) return this.syncing;
    if (globalThis.navigator?.onLine === false) {
      this.publish({ error: { status: 0, code: 'OFFLINE', message: 'Нет подключения к сети' } });
      return Promise.resolve(false);
    }
    const perform = () => this.runSync();
    const locks = globalThis.navigator?.locks;
    const attempt = locks ? locks.request(`${this.database}:sync`, perform) : perform();
    this.syncing = attempt.catch(error => {
      this.publish({ error: problem(error) });
      return false;
    }).finally(() => {
      this.syncing = null;
      if (this.syncAgain) {
        this.syncAgain = false;
        this.scheduleSync();
      }
    });
    return this.syncing;
  }

  async runSync() {
    this.publish({ syncing: true, error: null });
    try {
      await this.pull();
      let pushed = false;
      for (;;) {
        const operation = await this.nextOperation();
        if (!operation || operation.failure) break;
        try {
          const ack = await syncRequest('/api/sync', { method: 'POST', body: JSON.stringify(wire(operation)) });
          if (ack.operation_id !== operation.operation_id || !Array.isArray(ack.changes)) throw new Error('Не удалось подтвердить сохранение');
          await this.accept(operation, ack.changes);
          pushed = true;
        } catch (error) {
          if (![409, 422].includes(error.status) && error.payload?.error?.code !== 'INVALID_SYNC_OPERATION') throw error;
          await this.recordConflict(operation, error);
          break;
        }
      }
      if (pushed) await this.pull();
      await this.changed();
      return this.state.ready && this.state.pending === 0;
    } finally {
      this.publish({ syncing: false });
    }
  }

  async pull() {
    const meta = await transaction(this.db, ['meta'], 'readonly', async store => (await resultOf(store.get(metaKey))) ?? absent());
    let cursor = meta.cursor;
    let through;
    let replacement = null;
    let extended = false;
    for (;;) {
      const query = new URLSearchParams({ after: cursor });
      if (through !== undefined && through >= cursor) query.set('through', through);
      let page;
      try {
        page = await syncRequest(`/api/sync?${query}`);
      } catch (error) {
        if (error.payload?.error?.code !== 'SYNC_CURSOR_EXPIRED' || replacement) throw error;
        // Keep the previous local journal until a full replacement has arrived.
        replacement = [];
        cursor = 0;
        through = undefined;
        continue;
      }
      if (!Number.isSafeInteger(page.cursor) || page.cursor < cursor || !Array.isArray(page.changes) || (page.has_more && page.cursor === cursor)) throw new Error('Сервер вернул неполную страницу синхронизации');
      if (replacement) replacement.push(...page.changes);
      cursor = page.cursor;
      if (!page.has_more) {
        const missingSettings = replacement && !replacement.some(change => change.kind === 'settings' && change.value);
        if (!missingSettings && await this.applyPage(page, replacement)) return;
        if (through === undefined || extended) throw new Error('Сервер не вернул настройки журнала');
        // The settings row can move above a fixed pagination watermark during bootstrap.
        through = undefined;
        extended = true;
        continue;
      }
      if (!replacement) await this.applyPage(page, null);
      through = page.through;
    }
  }

  applyPage(page, replacement) {
    return transaction(this.db, ['entities', 'meta'], 'readwrite', async (entities, dbMeta) => {
      const meta = (await resultOf(dbMeta.get(metaKey))) ?? absent();
      if (replacement) await resultOf(entities.clear());
      await mergeChanges(entities, replacement ?? page.changes);
      const settings = await resultOf(entities.get(entityKey('settings', 1)));
      const ready = Boolean(settings?.value) && (meta.ready || !page.has_more);
      dbMeta.put({
        ...meta, cursor: replacement ? page.cursor : Math.max(page.cursor, meta.cursor),
        ready, serverNow: page.server_now,
        lastSync: ready && !page.has_more ? Date.now() : meta.lastSync,
      }, metaKey);
      return ready;
    });
  }

  nextOperation() {
    return transaction(this.db, ['outbox'], 'readwrite', async outbox => {
      const first = await resultOf(outbox.openCursor());
      const operation = first?.value;
      if (operation && !operation.attempted && !operation.failure) {
        operation.attempted = true;
        first.update(operation);
      }
      return operation;
    });
  }

  accept(operation, changes) {
    return transaction(this.db, ['entities', 'outbox'], 'readwrite', async (entities, outbox) => {
      const current = await resultOf(outbox.get(operation.position));
      await mergeChanges(entities, changes);
      if (current?.operation_id === operation.operation_id) outbox.delete(operation.position);
    });
  }

  recordConflict(operation, error) {
    return transaction(this.db, ['entities', 'outbox'], 'readwrite', async (entities, outbox) => {
      const current = await resultOf(outbox.get(operation.position));
      if (current?.operation_id !== operation.operation_id) return;
      const changes = error.payload?.changes ?? [];
      await mergeChanges(entities, changes);
      outbox.put({ ...current, failure: { error: problem(error), changes } });
    });
  }

  async resolve(action, { ended_at } = {}) {
    const conflicted = this.state.conflict?.operation.operation_id;
    await transaction(this.db, ['entities', 'outbox'], 'readwrite', async (entities, outbox) => {
      const [rows, queue] = await Promise.all([resultOf(entities.getAll()), resultOf(outbox.getAll())]);
      const original = queue[0];
      if (!original?.failure || original.operation_id !== conflicted) return;
      const cloud = new Map(rows.map(row => [row.key, row.value]));
      const remote = cloud.get(operationTarget(original));
      let replacement = null;
      if (action === 'local' && canRebase(original, remote)) {
        replacement = { type: original.type, payload: { ...original.payload, expected_revision: remote?.revision ?? 0 }, before: remote };
        if (original.type === 'entry.finish' && remote.ended_at !== null) {
          const { id, clicked_ended_at, final_patch } = original.payload;
          const ended_at = Math.max(remote.started_at, clicked_ended_at);
          replacement.type = 'entry.update';
          replacement.payload = { id, expected_revision: remote.revision, ...entryPatch(final_patch ?? {}), ended_at, ...(ended_at !== clicked_ended_at ? { estimated: true } : {}) };
        }
      } else if (action === 'closed' && canClose(original, remote, cloud.get(entryKey(original.payload.new_entry_id)))) {
        const draft = original.payload;
        const start = original.type === 'entry.switch' ? { ...draft.preset, id: draft.new_entry_id, started_at: draft.switch_at } : draft;
        const finish = queue.find(item => item.type === 'entry.finish' && item.payload.id === start.id);
        const end = finish?.payload.clicked_ended_at ?? ended_at;
        if (!Number.isSafeInteger(end) || end + 2000 < start.started_at) throw new Error('Укажите окончание после начала обращения');
        const payload = closedPayload(start, end);
        delete payload.expected_revision;
        replacement = { type: 'entry.create', payload };
        // Preserve a queued finish's place among field edits after creating the interval closed.
        if (finish) {
          const { id, expected_revision, final_patch } = finish.payload;
          finish.type = 'entry.update';
          finish.payload = { id, expected_revision, ...entryPatch(final_patch ?? {}), ended_at: payload.ended_at };
          outbox.put(finish);
        }
      } else if (action !== 'remote') {
        throw new Error('Этот вариант больше недоступен. Проверьте облачную версию.');
      }
      if (replacement) {
        Object.assign(replacement, { position: original.position, operation_id: crypto.randomUUID(), attempted: false });
        outbox.put(replacement);
      } else outbox.delete(original.position);
      rebaseDependents(outbox, queue, original, replacement, cloud);
    });
    await this.changed();
    this.scheduleSync();
  }

  legacyDrafts() {
    try {
      return Object.keys(localStorage).filter(key => key.startsWith(legacyPrefix)).flatMap(key => {
        try {
          const draft = JSON.parse(localStorage.getItem(key));
          const pending = draft && (draft.phase === 'create' || draft.finish || draft.switch || Object.keys(draft.pending ?? {}).length);
          return pending && typeof draft.id === 'string' ? [{ key, draft }] : [];
        } catch { return []; }
      });
    } catch { return []; }
  }

  async restoreDraft(key) {
    const draft = this.legacyDrafts().find(item => item.key === key)?.draft;
    if (!draft) return;
    await transaction(this.db, stores, 'readwrite', async (entities, outbox, dbMeta) => {
      const [rows, queue, meta] = await Promise.all([resultOf(entities.getAll()), resultOf(outbox.getAll()), resultOf(dbMeta.get(metaKey))]);
      if (!meta?.ready) throw new Error('Сначала загрузите журнал через интернет');
      if (meta.restoredDrafts.includes(key)) return;
      const commands = [];
      const confirmed = new Map(rows.map(row => [row.key, row.value]));
      const existing = confirmed.get(entryKey(draft.id));
      const fields = select({ ...draft.fields, ...draft.pending }, entryFields);
      const differences = Object.fromEntries(Object.entries(fields).filter(([field, value]) => (existing?.[field] ?? null) !== (field === 'kind' ? value || 'unknown' : value ?? null)));
      const patch = draft.phase === 'create' ? differences : select(draft.pending ?? {}, entryFields);
      let revision = draft.entry?.revision ?? existing?.revision ?? 1;
      if (draft.phase === 'create' && !existing) {
        const timer = { id: draft.id, started_at: draft.started_at, mode: 'timer', ...fields };
        commands.push(['entry.create', draft.finish ? closedPayload(timer, draft.finish) : timer]);
      } else {
        if (Object.keys(patch).length) commands.push(['entry.update', { id: draft.id, expected_revision: revision++, ...patch }]);
        if (draft.finish && existing?.ended_at !== draft.finish) commands.push(['entry.finish', { id: draft.id, expected_revision: revision, clicked_ended_at: draft.finish }]);
      }
      if (draft.switch && !confirmed.get(entryKey(draft.switch.new_entry_id))) {
        commands.push(['entry.switch', draft.switch.payload ?? { expected_id: draft.id, expected_revision: revision, ...select(draft.switch, ['new_entry_id', 'switch_at']) }]);
      }
      for (const [type, payload] of commands) {
        const operation = newOperation(type, payload, project(rows, queue).view, queue);
        await resultOf(outbox.add(operation));
        queue.push(operation);
      }
      dbMeta.put({ ...meta, restoredDrafts: [...meta.restoredDrafts, key] }, metaKey);
    });
    localStorage.removeItem(key);
    await this.changed();
    this.scheduleSync();
  }
}
