import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { OfflineStore } from '../frontend/public/js/offline.js';

const settings = { id: 1, revision: 1, timezone: 'Europe/Moscow', analysis_context: '', pinned_actions: [] };
const entry = (id, fields = {}) => ({ id, revision: 1, mode: 'timer', started_at: 1000, ended_at: null, ...fields });

function fixture(t) {
  const navigator = { onLine: true };
  const storage = Object.create({
    getItem(key) { return this[key] ?? null; },
    removeItem(key) { delete this[key]; },
  });
  const stores = [];
  const rows = new Map();
  const receipts = new Map();
  const posts = [];
  const applied = [];
  let sequence = 0;
  const server = { posts, applied, loseResponse: false, responseGate: null, pageSize: 100, afterGet: null, getError: null };
  const key = (kind, id) => `${kind}:${id}`;
  function put(kind, id, value) {
    const change = { seq: ++sequence, kind, id: String(id), value };
    rows.set(key(kind, id), change);
    return change;
  }
  server.put = put;
  server.reset = () => {
    rows.clear();
    receipts.clear();
    sequence = 0;
    put('settings', 1, settings);
  };
  server.reset();
  const fetch = async (path, options) => {
    const params = new URL(path, 'https://offline.test').searchParams;
    if (options.method !== 'POST') {
      if (server.getError) return Response.json(server.getError.body, { status: server.getError.status });
      const after = Number(params.get('after') ?? 0), through = Number(params.get('through') ?? sequence);
      if (after > sequence || through > sequence) return Response.json({ error: { code: 'SYNC_CURSOR_EXPIRED', message: 'Курсор устарел' } }, { status: 409 });
      const found = [...rows.values()].filter(change => after < change.seq && change.seq <= through).sort((a, b) => a.seq - b.seq);
      const changes = found.slice(0, server.pageSize);
      const has_more = found.length > changes.length;
      const response = Response.json({ changes, cursor: has_more ? changes.at(-1).seq : through, through, has_more, server_now: Date.now() });
      server.afterGet?.(after, has_more);
      return response;
    }

    const operation = JSON.parse(options.body);
    const { operation_id, type, payload } = operation;
    posts.push(operation);
    if (receipts.has(operation_id)) {
      const receipt = receipts.get(operation_id);
      assert.deepEqual(operation, receipt.operation);
      return Response.json({ operation_id, changes: receipt.keys.map(key => rows.get(key)) });
    }

    const id = type === 'entry.switch' ? payload.expected_id : payload.id;
    const current = rows.get(key('entry', id));
    const active = [...rows.values()].find(change => change.kind === 'entry' && change.value?.ended_at === null);
    const revision = current?.value?.revision;
    let changes;
    if (type === 'entry.create' && payload.ended_at == null && active) {
      return Response.json({ error: { code: 'ACTIVE_ENTRY_EXISTS', message: 'Уже идёт обращение' }, changes: [active] }, { status: 409 });
    }
    if (type !== 'entry.create' && revision !== payload.expected_revision) {
      return Response.json({ error: { code: 'ENTRY_CHANGED', message: 'Запись изменилась' }, changes: current ? [current] : [] }, { status: 409 });
    }
    if (type === 'entry.create') changes = [put('entry', id, entry(id, payload))];
    if (type === 'entry.update') changes = [put('entry', id, { ...current.value, ...payload, revision: revision + 1 })];
    if (type === 'entry.finish') changes = [put('entry', id, { ...current.value, ...payload.final_patch, ended_at: payload.clicked_ended_at, revision: revision + 1 })];
    if (type === 'entry.switch') changes = [
      put('entry', id, { ...current.value, ...payload.closing_patch, ended_at: payload.switch_at, revision: revision + 1 }),
      put('entry', payload.new_entry_id, entry(payload.new_entry_id, { ...payload.preset, started_at: payload.switch_at })),
    ];
    applied.push(operation);
    receipts.set(operation_id, { operation, keys: changes.map(change => key(change.kind, change.id)) });
    if (server.loseResponse) {
      server.loseResponse = false;
      throw Error('response lost');
    }
    if (server.responseGate) {
      const gate = server.responseGate;
      server.responseGate = null;
      gate.arrived.resolve();
      await gate.release.promise;
    }
    return Response.json({ operation_id, changes });
  };

  for (const [name, value] of Object.entries({ indexedDB: new IDBFactory(), BroadcastChannel: undefined, navigator, fetch, localStorage: storage })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  t.after(() => stores.forEach(store => store.close()));
  const open = async (database = 'client') => {
    const store = new OfflineStore(undefined, { database });
    stores.push(store);
    await store.open();
    return store;
  };
  return { navigator, open, server, storage };
}

test('незавершённая настройка входа отличается от временного сбоя синхронизации', async t => {
  const { navigator, open, server } = fixture(t);
  const store = await open();
  server.getError = { status: 503, body: { error: { code: 'AUTH_CONFIGURATION_ERROR' } } };
  assert.equal(await store.sync(), false);
  assert.equal(store.state.ready, false);
  assert.deepEqual(store.state.error, {
    status: 503, code: 'AUTH_CONFIGURATION_ERROR', message: 'Вход в приложение ещё не настроен.',
  });
  await assert.rejects(store.enqueue('entry.create', { id: 'early', started_at: 1000 }), /Сначала загрузите журнал/);

  server.getError = null;
  assert.equal(await store.sync(), true);
  navigator.onLine = false;
  await store.enqueue('entry.create', { id: 'later', started_at: 2000 });
  navigator.onLine = true;
  server.getError = { status: 503, body: { error: { code: 'SYNC_UNAVAILABLE', message: 'Синхронизация временно недоступна' } } };
  assert.equal(await store.sync(), false);
  assert.equal(store.state.ready, true);
  assert.equal(store.state.pending, 1);
  assert.deepEqual(store.state.error, {
    status: 503, code: 'SYNC_UNAVAILABLE', message: 'Синхронизация временно недоступна.',
  });
});

test('несколько офлайн-записей переживают перезапуск, законченный таймер отправляется один раз', async t => {
  const { navigator, open, server } = fixture(t);
  let store = await open();
  assert.equal(store.state.ready, false);
  assert.equal(await store.sync(), true);
  navigator.onLine = false;
  await store.enqueue('entry.create', { id: 'timer', started_at: 1000 });
  await store.enqueue('entry.update', { id: 'timer', expected_revision: 1, kind: 'Проблема' });
  await store.enqueue('entry.update', { id: 'timer', expected_revision: 1, kind: 'Координация' });
  await store.enqueue('entry.finish', { id: 'timer', expected_revision: 1, clicked_ended_at: 1500 });
  await store.enqueue('entry.create', { id: 'manual', mode: 'manual', started_at: 3000, ended_at: 3500 });
  store.close();
  store = await open();
  assert.equal(store.state.pending, 2);
  assert.equal(store.state.active, null);
  assert.equal(store.state.entries.find(row => row.id === 'timer').kind, 'Координация');
  server.put('entry', 'other', entry('other'));
  navigator.onLine = true;
  assert.equal(await store.sync(), true);
  assert.equal(store.state.pending, 0);
  assert.equal(store.state.active.id, 'other');
  assert.deepEqual(server.posts.map(op => op.type), ['entry.create', 'entry.create']);
  assert.deepEqual(server.posts[0].payload, { id: 'timer', started_at: 1000, kind: 'Координация', ended_at: 1500 });
});

test('ответ на уже отправленную правку не теряет следующие правки и время завершения', async t => {
  const { open, server } = fixture(t);
  const store = await open();
  server.put('entry', 'timer', entry('timer'));
  await store.sync();
  const gate = { arrived: Promise.withResolvers(), release: Promise.withResolvers() };
  server.responseGate = gate;
  await store.enqueue('entry.update', { id: 'timer', expected_revision: 1, kind: 'Проблема' });
  await gate.arrived.promise;
  await store.enqueue('entry.update', { id: 'timer', expected_revision: 2, kind: 'Координация' });
  await store.enqueue('entry.finish', { id: 'timer', expected_revision: 3, clicked_ended_at: 1500 });
  assert.equal(store.state.entries[0].kind, 'Координация');
  assert.equal(store.state.entries[0].ended_at, 1500);
  gate.release.resolve();
  assert.equal(await store.sync(), true);
  assert.deepEqual(server.posts.map(op => op.payload.expected_revision), [1, 2, 3]);
  assert.equal(store.state.entries[0].ended_at, 1500);
  assert.equal(store.state.entries[0].kind, 'Координация');
});

test('после потери ответа переключение повторяет прежний UUID, тело и время', async t => {
  const { open, server } = fixture(t);
  let store = await open();
  server.put('entry', 'timer', entry('timer'));
  await store.sync();
  server.loseResponse = true;
  await store.enqueue('entry.switch', { expected_id: 'timer', new_entry_id: 'next', expected_revision: 1, switch_at: 1500 });
  assert.equal(await store.sync(), false);
  assert.equal(store.state.pending, 1);
  store.close();
  store = await open();
  assert.equal(await store.sync(), true);
  assert.deepEqual(server.posts[1], server.posts[0]);
  assert.equal(server.applied.length, 1);
  assert.equal(store.state.active.id, 'next');
  assert.equal(store.state.active.started_at, 1500);
});

test('выбор локальной версии сохраняет правки, сделанные после конфликтующего действия', async t => {
  const { navigator, open, server } = fixture(t);
  const store = await open();
  server.put('entry', 'timer', entry('timer'));
  await store.sync();
  navigator.onLine = false;
  await store.enqueue('entry.update', { id: 'timer', expected_revision: 1, note: 'Локальная заметка' });
  await store.enqueue('entry.update', { id: 'timer', expected_revision: 2, source_name: 'Источник' });
  server.put('entry', 'timer', entry('timer', { revision: 2, note: 'Облачная заметка' }));
  navigator.onLine = true;
  assert.equal(await store.sync(), false);
  assert.equal(store.state.conflict.changes[0].value.note, 'Облачная заметка');
  assert.equal(store.state.conflict.local[0].note, 'Локальная заметка');
  assert.equal(store.state.pending, 2);
  await store.resolve('local');
  assert.equal(await store.sync(), true);
  assert.notEqual(server.posts[1].operation_id, server.posts[0].operation_id);
  assert.deepEqual(server.posts.map(op => op.payload.expected_revision), [1, 2, 3]);
  assert.equal(store.state.entries[0].note, 'Локальная заметка');
  assert.equal(store.state.entries[0].source_name, 'Источник');
});

test('конфликт двух таймеров сохраняет локальное время завершения и облачный таймер', async t => {
  const { navigator, open, server } = fixture(t);
  const store = await open();
  await store.sync();
  navigator.onLine = false;
  await store.enqueue('entry.create', { id: 'local', started_at: 1000 });
  server.put('entry', 'remote', entry('remote'));
  navigator.onLine = true;
  assert.equal(await store.sync(), false);
  assert.equal(store.state.conflict.canSaveClosed, true);
  assert.equal(store.state.active.id, 'local');
  navigator.onLine = false;
  await store.enqueue('entry.update', { id: 'local', expected_revision: 1, kind: 'Проблема' });
  await store.enqueue('entry.finish', { id: 'local', expected_revision: 2, clicked_ended_at: 2000, final_patch: { kind: 'Координация' } });
  await store.enqueue('entry.update', { id: 'local', expected_revision: 3, note: 'После завершения' });
  await store.resolve('closed', { ended_at: 3000 });
  navigator.onLine = true;
  assert.equal(await store.sync(), true);
  assert.equal(store.state.active.id, 'remote');
  const local = store.state.entries.find(item => item.id === 'local');
  assert.equal(local.ended_at, 2000);
  assert.equal(local.kind, 'Координация');
  assert.equal(local.note, 'После завершения');
});

test('восстановление старого черновика сохраняет только отличающиеся поля уже созданного таймера', async t => {
  const { open, server, storage } = fixture(t);
  const store = await open();
  server.put('entry', 'timer', entry('timer', { kind: 'Проблема', source_name: 'Глеб' }));
  await store.sync();
  const key = 'interruptions.draft.v1.former-tab';
  storage[key] = JSON.stringify({ id: 'timer', phase: 'create', started_at: 1000, fields: { source_name: 'Глеб', kind: 'Координация' } });
  assert.equal(store.legacyDrafts().length, 1);
  await store.restoreDraft(key);
  assert.equal(await store.sync(), true);
  assert.deepEqual(server.posts.map(op => op.payload), [{ id: 'timer', expected_revision: 1, kind: 'Координация' }]);
  assert.equal(store.legacyDrafts().length, 0);
});

test('начальная загрузка догоняет настройки, изменившиеся между страницами', async t => {
  const { open, server } = fixture(t);
  const store = await open();
  server.put('entry', 'one', entry('one'));
  server.put('settings', 1, settings);
  server.put('entry', 'two', entry('two'));
  server.pageSize = 1;
  server.afterGet = (after, hasMore) => {
    if (after === 0 && hasMore) {
      server.put('settings', 1, { ...settings, revision: 2 });
      server.afterGet = null;
    }
  };
  assert.equal(await store.sync(), true);
  assert.equal(store.state.settings.revision, 2);
  assert.equal(store.state.entries.length, 2);
});

test('устаревший курсор заменяет подтверждённый снимок, сохраняя очередь', async t => {
  const { navigator, open, server } = fixture(t);
  const store = await open();
  server.put('entry', 'former', entry('former', { ended_at: 1500 }));
  await store.sync();
  navigator.onLine = false;
  await store.enqueue('entry.create', { id: 'offline', started_at: 2000, ended_at: 2500 });
  server.reset();
  navigator.onLine = true;
  assert.equal(await store.sync(), true);
  assert.deepEqual(store.state.entries.map(item => item.id), ['offline']);
  assert.equal(server.applied.length, 1);
});
