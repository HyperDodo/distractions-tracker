const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store'}});
const fail = (code, message, status, extra={}) => json({error:{code,message},...extra},status);
const fields = {source_name:'source_name',kind:'kind',note:'note',involvement_reason:'why_me',estimated:'time_estimated'};
const expose = e => e && ({...e, involvement_reason:e.why_me, estimated:!!e.time_estimated, mode:e.capture_mode});
const get = (db,id) => db.prepare('SELECT * FROM entries WHERE id=?').bind(id).first();
const revision = db => db.prepare('SELECT data_revision FROM settings WHERE id=1').first();
const readEntry = (db,id) => db.prepare('SELECT * FROM entries WHERE id=?').bind(id);
const readRevision = db => db.prepare('SELECT data_revision FROM settings WHERE id=1');
const entryFrom = result => expose(result.results[0] || null);
const revisionFrom = result => result.results[0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isEntryId = value => typeof value === 'string' && UUID.test(value);
function patch(body) {
 const out = {};
 for (const [key,col] of Object.entries(fields)) if (Object.hasOwn(body,key)) {
   let value = body[key];
   if (key === 'estimated') value = value ? 1 : 0;
   else if (value != null) { if (typeof value !== 'string' || value.length > (key==='note'?500:80)) throw Error('Некорректное поле'); value = value.trim() || null; }
   if (key==='kind' && value === null) value='unknown';
   out[col]=value;
 }
 return out;
}
const validTime = value => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;
function checkTime(start,end,manual=false) {
 if (!validTime(start) || (end!==null && !validTime(end))) throw Error('Некорректное время');
 if (end!==null && (end<start || (manual && end>Date.now()))) throw Error('Некорректный интервал');
}

const insertColumns = 'id,started_at,ended_at,source_name,kind,note,why_me,capture_mode,time_estimated,created_at,updated_at';
export const bumpDataRevision = db => db.prepare('UPDATE settings SET data_revision=data_revision+1 WHERE id=1 AND changes()=1');

function createEntry(db, b, now) {
 if (!isEntryId(b.id)) throw Error('Некорректный ID');
 const mode = b.mode || 'timer', start = b.started_at, end = b.ended_at ?? null;
 if (!['timer', 'manual'].includes(mode) || (mode === 'manual' && end === null)) throw Error('Некорректный режим');
 checkTime(start, end, mode === 'manual');
 const p = patch(b);
 return db.prepare(`INSERT INTO entries(${insertColumns}) SELECT ?,?,?,?,?,?,?,?,?,?,?
   WHERE NOT EXISTS(SELECT 1 FROM entries WHERE id=?)
     AND (? IS NOT NULL OR NOT EXISTS(SELECT 1 FROM entries WHERE ended_at IS NULL))`)
   .bind(b.id,start,end,p.source_name??null,p.kind??'unknown',p.note??null,p.why_me??null,mode,p.time_estimated??(mode==='manual'?1:0),now,now,b.id,end);
}

function switchEntry(db, b, old, now) {
 if (!isEntryId(b.new_entry_id) || !isEntryId(b.expected_id)) throw Error('Некорректный ID');
 if (!old || old.ended_at !== null || old.revision !== b.expected_revision) return {writes:[]};
 if (!validTime(b.switch_at)) throw Error('Некорректное время');
 let at = b.switch_at, adjusted = false;
 if (at < old.started_at && old.started_at - at <= 2000) { at = old.started_at; adjusted = true; }
 checkTime(old.started_at,at);
 const p = patch(b.closing_patch || {}), next = patch(b.preset || {});
 if (adjusted) p.time_estimated = 1;
 const sets = Object.keys(p).map(k=>`${k}=?`);
 const close = db.prepare(`UPDATE entries SET ended_at=?,updated_at=?,revision=revision+1${sets.length?','+sets.join(','):''}
   WHERE id=? AND revision=? AND ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM entries WHERE id=?)`)
   .bind(at,now,...Object.values(p),b.expected_id,b.expected_revision,b.new_entry_id);
 const start = db.prepare(`INSERT INTO entries(${insertColumns})
   SELECT ?,?,NULL,?,?,?,?, 'timer',?,?,? WHERE changes()=1`)
   .bind(b.new_entry_id,at,next.source_name??null,next.kind??'unknown',next.note??null,next.why_me??null,adjusted?1:(next.time_estimated??0),now,now);
 return {writes:[close,start], adjusted};
}

// Used by both the existing HTTP entry endpoints and the durable sync receipt transaction.
export function prepareEntryMutation(db, type, b, old) {
 const now = Date.now();
 if (type === 'entry.create') return {writes:[createEntry(db,b,now)]};
 if (!Number.isSafeInteger(b.expected_revision) || b.expected_revision < 1) throw Error('Укажите редакцию');
 if (type === 'entry.switch') return switchEntry(db,b,old,now);
 if (!isEntryId(b.id)) throw Error('Некорректный ID');
 if (!old || old.revision !== b.expected_revision) return {writes:[]};
 if (type === 'entry.delete') return {writes:[db.prepare('DELETE FROM entries WHERE id=? AND revision=?').bind(b.id,b.expected_revision)]};

 const finishing = type === 'entry.finish';
 if (finishing && old.ended_at !== null) return {writes:[]};
 let adjusted = false;
 const p = patch(b.final_patch || b);
 if (finishing) {
  if (!validTime(b.clicked_ended_at)) throw Error('Некорректное время');
  let end = b.clicked_ended_at;
  if (end < old.started_at && old.started_at - end <= 2000) { end = old.started_at; adjusted = true; p.time_estimated = 1; }
  checkTime(old.started_at,end);
  p.ended_at = end;
 } else {
  if (Object.hasOwn(b,'started_at')) p.started_at = b.started_at;
  if (Object.hasOwn(b,'ended_at')) {
   if (old.ended_at === null || b.ended_at === null) throw Error('Нельзя изменить окончание активной записи');
   p.ended_at = b.ended_at;
  }
  checkTime(Object.hasOwn(p,'started_at')?p.started_at:old.started_at, p.ended_at??old.ended_at, old.ended_at!==null);
 }
 const sets = Object.keys(p).map(k=>`${k}=?`);
 const sql = `UPDATE entries SET ${sets.length?sets.join(',')+',':''}updated_at=?,revision=revision+1
   WHERE id=? AND revision=?${finishing?' AND ended_at IS NULL':''}`;
 return {writes:[db.prepare(sql).bind(...Object.values(p),now,b.id,b.expected_revision)], adjusted};
}
async function result(db,id,operation_result='applied',extra={}) { const [entry,rev]=await db.batch([readEntry(db,id),readRevision(db)]); return json({entry:entryFrom(entry),operation_result,...revisionFrom(rev),...extra}); }
async function conflict(db,id) { const [e,rev]=await db.batch([readEntry(db,id),readRevision(db)]); const current=entryFrom(e); return current ? fail('ENTRY_CHANGED','Запись изменена на другом устройстве',409,{current_entry:current,...revisionFrom(rev)}) : fail('NOT_FOUND','Запись не найдена',404); }
export async function handleEntries(request,env) {
 const db=env.DB, u=new URL(request.url), path=u.pathname, method=request.method;
 if (!path.startsWith('/api/entries')) return null;
 const match=path.match(/^\/api\/entries\/([^/]+)(?:\/(finish))?$/);
 try {
 if(method==='GET' && match && match[1]!=='switch') {const e=await get(db,match[1]); return e?json({entry:expose(e),...await revision(db)}):fail('NOT_FOUND','Запись не найдена',404);}
 if(method==='POST' && path==='/api/entries') {
  const b=await request.json(), {writes}=prepareEntryMutation(db,'entry.create',b);
  const [written,,entry,rev,active]=await db.batch([...writes,bumpDataRevision(db),readEntry(db,b.id),readRevision(db),db.prepare('SELECT * FROM entries WHERE ended_at IS NULL')]);
  const current=entryFrom(entry), dataRevision=revisionFrom(rev);
  if (written.meta.changes) return json({entry:current,operation_result:'applied',...dataRevision});
  if (current) {
   if (current.started_at!==b.started_at || current.capture_mode!==(b.mode||'timer')) return fail('ID_REUSE_CONFLICT','Идентификатор уже использован',409);
   return json({entry:current,operation_result:'existing',...dataRevision});
  }
  return fail('ACTIVE_ENTRY_EXISTS','Уже есть активное обращение',409,{active_entry:entryFrom(active),...dataRevision});
 }
 if(method==='POST' && path==='/api/entries/switch') {
  const b=await request.json(); if(!isEntryId(b.new_entry_id) || !isEntryId(b.expected_id) || !Number.isInteger(b.expected_revision)) throw Error('Некорректный запрос');
  const existing=await get(db,b.new_entry_id);
  if(existing) return json({new_entry:expose(existing),operation_result:'existing',...await revision(db)});
  const {writes,adjusted}=prepareEntryMutation(db,'entry.switch',b,await get(db,b.expected_id));
  if(!writes.length)return conflict(db,b.expected_id);
  const [closed,,,old,next,rev]=await db.batch([...writes,bumpDataRevision(db),readEntry(db,b.expected_id),readEntry(db,b.new_entry_id),readRevision(db)]);
  if(!closed.meta.changes) return entryFrom(next) ? json({new_entry:entryFrom(next),operation_result:'existing',...revisionFrom(rev)}) : conflict(db,b.expected_id);
  return json({old_entry:entryFrom(old),new_entry:entryFrom(next),operation_result:'applied',time_adjusted:adjusted,...revisionFrom(rev)});
 }
 if(match && ((['PATCH','DELETE'].includes(method) && !match[2]) || (method==='POST' && match[2]==='finish'))) {
  const id=match[1], b=await request.json(), old=await get(db,id); if(!old)return conflict(db,id);
  if(method==='POST' && match[2]==='finish' && old.ended_at!==null)return result(db,id,'already_finished');
  const type=method==='DELETE'?'entry.delete':match[2]?'entry.finish':'entry.update';
  const {writes,adjusted}=prepareEntryMutation(db,type,{...b,id},old);
  if(!writes.length)return conflict(db,id);
  const [written,,entry,rev]=await db.batch([...writes,bumpDataRevision(db),readEntry(db,id),readRevision(db)]); if(!written.meta.changes)return conflict(db,id);
  return method==='DELETE'?json({operation_result:'applied',...revisionFrom(rev)}):json({entry:entryFrom(entry),operation_result:'applied',time_adjusted:adjusted,...revisionFrom(rev)});
 }
 return null;
 } catch(e) {if(e instanceof SyntaxError || e.message.startsWith('Некоррект') || e.message.startsWith('Укажите') || e.message.startsWith('Нельзя')) return fail('INVALID_INTERVAL',e.message,422); console.error('ENTRY_ERROR');return fail('INTERNAL_ERROR','Не удалось выполнить запрос',500);}
}
export {expose};
