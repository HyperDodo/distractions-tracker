import {bounds} from './calendar.js';
import {bumpDataRevision, expose, isEntryId, prepareEntryMutation} from './entries.js';

const pageSize = 100;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const kinds = ['Согласование','Проблема','Координация','Сделать руками','Сам отвлёкся','Другое'];
const types = new Set(['entry.create','entry.update','entry.delete','entry.finish','entry.switch','day_note.put','settings.patch']);
const revisionValid = (value, min = 1) => Number.isSafeInteger(value) && value >= min;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = (body, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'no-store'}});
const error = (code, message, status, extra = {}) => json({error:{code,message},...extra},status);

const fields = {
 entry: 'id,started_at,ended_at,source_name,kind,note,why_me,capture_mode,time_estimated,created_at,updated_at,revision',
 day_note: 'date,planned_minutes,available_minutes,outcomes_note,coverage,updated_at,revision',
 settings: 'id,timezone,pinned_actions_json,analysis_context,revision,data_revision',
 report: 'id,kind,status,date_from,date_to_exclusive,timezone,created_at,updated_at,completed_at,input_revision,provider,model,prompt_version,result_json,error_code,input_tokens,output_tokens,cost'
};

function rowJson(kind, alias, identity) {
 const pairs = fields[kind].split(',').map(field => `'${field}',${alias}.${field}`).join(',');
 return `WHEN '${kind}' THEN CASE WHEN ${alias}.${identity} IS NOT NULL THEN json_object(${pairs}) END`;
}

function readChanges(db, selection, args) {
 return db.prepare(`SELECT c.seq,c.kind,c.id,CASE c.kind
   ${rowJson('entry','e','id')}
   ${rowJson('day_note','n','date')}
   ${rowJson('settings','s','id')}
   ${rowJson('report','r','id')}
  END AS value
  FROM (${selection}) AS c
  LEFT JOIN entries e ON c.kind='entry' AND e.id=c.id
  LEFT JOIN day_notes n ON c.kind='day_note' AND n.date=c.id
  LEFT JOIN settings s ON c.kind='settings' AND c.id='1' AND s.id=1
  LEFT JOIN reports r ON c.kind='report' AND r.id=c.id AND r.status<>'deleted'
  ORDER BY c.seq`).bind(...args);
}

export function exposeGeneralSettings(row) {
 return {
  id:row.id, timezone:row.timezone, pinned_actions:JSON.parse(row.pinned_actions_json),
  analysis_context:row.analysis_context, revision:row.revision, data_revision:row.data_revision
 };
}

function presentChange(row) {
 let value = row.value === null ? null : JSON.parse(row.value);
 if (value && row.kind === 'settings') value = exposeGeneralSettings(value);
 if (value && row.kind === 'entry') value = expose(value);
 return {seq:row.seq,kind:row.kind,id:row.id,value};
}

function readAffected(db, keys, includeActive) {
 const references = keys.map(() => 'SELECT ? AS kind,? AS id');
 if (includeActive) references.push("SELECT 'entry',id FROM entries WHERE ended_at IS NULL");
 return readChanges(db, `SELECT COALESCE(s.seq,0) AS seq,k.kind,k.id
  FROM (${references.join(' UNION ')}) k LEFT JOIN sync_entities s ON s.kind=k.kind AND s.id=k.id`, keys.flat());
}

const head = 'SELECT COALESCE(MAX(seq),0) FROM sync_entities';

function cursorParam(params, name, fallback) {
 const text = params.get(name);
 if (text === null) return fallback;
 if (!/^\d+$/.test(text) || !revisionValid(Number(text),0)) return NaN;
 return Number(text);
}

async function pull(db, params) {
 const after = cursorParam(params,'after',0), through = cursorParam(params,'through',null);
 if (!revisionValid(after,0) || (through !== null && !revisionValid(through,after))) {
  return error('INVALID_SYNC_CURSOR','Некорректная позиция синхронизации',400);
 }
 const [highWatermark,page] = await db.batch([
  db.prepare(`SELECT (${head}) AS head`),
  readChanges(db, `SELECT seq,kind,id FROM sync_entities
   WHERE seq>? AND seq<=COALESCE(?,(${head})) ORDER BY seq LIMIT ?`,[after,through,pageSize+1])
 ]);
 const top = highWatermark.results[0].head;
 if (after > top || (through !== null && through > top)) {
  return error('SYNC_CURSOR_EXPIRED','Состояние облачного журнала изменилось',409);
 }
 const limit = through ?? top, hasMore = page.results.length > pageSize;
 const changes = page.results.slice(0,pageSize).map(presentChange);
 return json({changes,cursor:hasMore?changes.at(-1).seq:limit,through:limit,has_more:hasMore,server_now:Date.now()});
}

function settingsWrite(db, payload) {
 const values = {};
 for (const key of ['timezone','analysis_context']) if (Object.hasOwn(payload,key)) {
  if (typeof payload[key] !== 'string' || payload[key].length > 2000) throw new Error('Проверьте настройки');
  values[key] = payload[key];
 }
 if (Object.hasOwn(values,'timezone')) bounds('2026-01-01',values.timezone);
 if (Object.hasOwn(payload,'pinned_actions')) {
  const pins = payload.pinned_actions;
  if (!Array.isArray(pins) || pins.length > 50) throw new Error('Проверьте закреплённые действия');
  values.pinned_actions_json = JSON.stringify(pins.map(pin => {
   if (!object(pin) || typeof pin.label !== 'string' || !pin.label.trim() || pin.label.length > 80 ||
    (pin.source_name != null && (typeof pin.source_name !== 'string' || pin.source_name.length > 80)) ||
    (pin.kind != null && !kinds.includes(pin.kind))) throw new Error('Проверьте закреплённые действия');
   return {label:pin.label.trim(),source_name:pin.source_name?.trim()||null,kind:pin.kind??null};
  }));
 }
 if (!Object.keys(values).length || Object.keys(payload).some(key => !['expected_revision','timezone','analysis_context','pinned_actions'].includes(key))) {
  throw new Error('Проверьте настройки');
 }
 const sets = Object.keys(values).map(key=>`${key}=?`).join(',');
 return [db.prepare(`UPDATE settings SET ${sets},revision=revision+1,data_revision=data_revision+1
  WHERE id=1 AND revision=?`).bind(...Object.values(values),payload.expected_revision)];
}

async function noteWrite(db, payload) {
 const {timezone} = await db.prepare('SELECT timezone FROM settings WHERE id=1').first();
 const range = bounds(payload.date,timezone);
 const maxMinutes = (range.end-range.start)/60000;
 const coverage = payload.coverage ?? 'unknown';
 const outcome = payload.outcomes_note ?? '';
 for (const key of ['planned_minutes','available_minutes']) {
  const value = payload[key];
  if (value != null && (!Number.isInteger(value) || value < 0 || value > maxMinutes)) throw new Error('Проверьте длительность в контексте дня');
 }
 if (!['unknown','partial','full'].includes(coverage) || typeof outcome !== 'string' || outcome.length > 2000) throw new Error('Проверьте контекст дня');
 return [db.prepare(`INSERT INTO day_notes(date,planned_minutes,available_minutes,outcomes_note,coverage,updated_at,revision)
  SELECT ?,?,?,?,?,?,1 WHERE (SELECT timezone FROM settings WHERE id=1)=?
   AND COALESCE((SELECT revision FROM day_notes WHERE date=?),0)=?
  ON CONFLICT(date) DO UPDATE SET planned_minutes=excluded.planned_minutes,available_minutes=excluded.available_minutes,
   outcomes_note=excluded.outcomes_note,coverage=excluded.coverage,updated_at=excluded.updated_at,revision=day_notes.revision+1`)
  .bind(payload.date,payload.planned_minutes??null,payload.available_minutes??null,payload.outcomes_note??null,coverage,
   Date.now(),timezone,payload.date,payload.expected_revision)];
}

function affected(type, payload) {
 if (type === 'settings.patch') return revisionValid(payload.expected_revision) ? [['settings','1']] : null;
 if (type === 'day_note.put') return datePattern.test(payload.date) && typeof payload.date === 'string' && revisionValid(payload.expected_revision,0)
  ? [['day_note',payload.date]] : null;
 if (type === 'entry.switch') return isEntryId(payload.expected_id) && isEntryId(payload.new_entry_id) && payload.expected_id !== payload.new_entry_id
  ? [['entry',payload.expected_id],['entry',payload.new_entry_id]] : null;
 return isEntryId(payload.id) ? [['entry',payload.id]] : null;
}

async function prepareWrites(db, type, payload) {
 if (type === 'settings.patch') return settingsWrite(db,payload);
 if (type === 'day_note.put') return noteWrite(db,payload);
 const id = type === 'entry.switch' ? payload.expected_id : payload.id;
 const old = type === 'entry.create' ? null : await db.prepare('SELECT * FROM entries WHERE id=?').bind(id).first();
 return prepareEntryMutation(db,type,payload,old).writes;
}

function stableStringify(value, depth = 0) {
 if (depth > 8) throw new Error('Invalid nesting');
 if (Array.isArray(value)) return `[${value.map(item=>stableStringify(item,depth+1)).join(',')}]`;
 if (object(value)) return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableStringify(value[key],depth+1)}`).join(',')}}`;
 return JSON.stringify(value);
}

async function fingerprint(type, payload) {
 const bytes = new TextEncoder().encode(stableStringify([type,payload]));
 const digest = await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

const readReceipt = (db, id) => db.prepare('SELECT fingerprint,through FROM sync_operations WHERE id=?').bind(id);

function outcome(operation, hash, receipt, changes) {
 const {operation_id, type, payload} = operation;
 if (receipt.fingerprint !== hash) return error('ID_REUSE_CONFLICT','Идентификатор операции уже использован',409,{operation_id,changes:[]});
 if (receipt.through !== null) return json({operation_id,changes,through:receipt.through});

 const extra = {operation_id,changes};
 if (type === 'settings.patch') return error('SETTINGS_CHANGED','Настройки изменены на другом устройстве',409,extra);
 if (type === 'day_note.put') return error('NOTE_CHANGED','Контекст дня изменён на другом устройстве',409,extra);
 if (type === 'entry.create' && payload.ended_at == null && changes.some(change=>change.id !== payload.id && change.value?.ended_at === null)) {
  return error('ACTIVE_ENTRY_EXISTS','На другом устройстве уже идёт обращение',409,extra);
 }
 return error('ENTRY_CHANGED','Запись изменена на другом устройстве',409,extra);
}

async function push(db, request) {
 let operation, keys, hash;
 try {
  const raw = await request.text();
  if (raw.length > 32000) throw new Error('Invalid length');
  operation = JSON.parse(raw);
  if (!object(operation) || !object(operation.payload) || !isEntryId(operation.operation_id) || !types.has(operation.type)) throw new Error('Invalid operation');
  keys = affected(operation.type,operation.payload);
  if (!keys) throw new Error('Invalid target');
  hash = await fingerprint(operation.type,operation.payload);
 } catch {
  return error('INVALID_SYNC_OPERATION','Некорректная операция синхронизации',400);
 }

 const {operation_id:id,type,payload} = operation;
 const affectedRows = includeActive => readAffected(db,keys,includeActive);
 const wantActive = type === 'entry.switch' || (type === 'entry.create' && payload.ended_at == null);
 async function replay(receipt) {
  const changes = receipt.fingerprint === hash ? (await affectedRows(wantActive && receipt.through === null).all()).results.map(presentChange) : [];
  return outcome(operation,hash,receipt,changes);
 }
 const existing = await readReceipt(db,id).first();
 if (existing) return replay(existing);

 let writes;
 try { writes = await prepareWrites(db,type,payload); }
 catch (err) {
  if (err instanceof RangeError || ['Некоррект','Проверьте','Укажите','Нельзя'].some(prefix=>err.message.startsWith(prefix))) {
   return error('INVALID_SYNC_OPERATION',err instanceof RangeError ? 'Проверьте дату и часовой пояс' : err.message,422);
  }
  throw err;
 }
 const record = db.prepare('INSERT INTO sync_operations (id,fingerprint) VALUES (?,?)').bind(id,hash);
 const complete = db.prepare(`UPDATE sync_operations SET through=(${head}) WHERE id=? AND changes()=1`).bind(id);
 const writeBatch = writes.length ? [...writes,...(type === 'settings.patch' ? [] : [bumpDataRevision(db)]),complete] : [];
 try {
  const result = await db.batch([record,...writeBatch,readReceipt(db,id),affectedRows(wantActive)]);
  const receipt = result.at(-2).results[0];
  const changes = result.at(-1).results.map(presentChange).filter(change=>receipt.through === null || keys.some(([kind,key])=>change.kind === kind && change.id === key));
  return outcome(operation,hash,receipt,changes);
 } catch (err) {
  const duplicate = await readReceipt(db,id).first();
  if (duplicate) return replay(duplicate);
  throw err;
 }
}

export async function handleSync(request, env) {
 const url = new URL(request.url);
 if (url.pathname !== '/api/sync') return null;
 try {
  if (request.method === 'GET') return await pull(env.DB,url.searchParams);
  if (request.method === 'POST') return await push(env.DB,request);
  return error('METHOD_NOT_ALLOWED','Метод синхронизации не поддерживается',405);
 } catch {
  console.error('SYNC_ERROR');
  return error('SYNC_UNAVAILABLE','Синхронизация временно недоступна',503);
 }
}
