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
function checkTime(start,end,manual=false) {
 if (!Number.isSafeInteger(start) || (end!==null && !Number.isSafeInteger(end))) throw Error('Некорректное время');
 if (end!==null && (end<start || (manual && end>Date.now()))) throw Error('Некорректный интервал');
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
  const b=await request.json(); if(!UUID.test(b.id)) throw Error('Некорректный ID');
  const existing=await get(db,b.id); if(existing) { if(existing.started_at!==b.started_at || existing.capture_mode!==(b.mode||'timer')) return fail('ID_REUSE_CONFLICT','Идентификатор уже использован',409); return result(db,b.id,'existing'); }
  const mode=b.mode||'timer', start=b.started_at, end=b.ended_at??null; if(!['timer','manual'].includes(mode) || (mode==='manual' && end===null)) throw Error('Некорректный режим'); checkTime(start,end,mode==='manual');
  const p=patch(b), now=Date.now();
  let written; try { written=await db.batch([db.prepare('INSERT INTO entries(id,started_at,ended_at,source_name,kind,note,why_me,capture_mode,time_estimated,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(b.id,start,end,p.source_name??null,p.kind??'unknown',p.note??null,p.why_me??null,mode,p.time_estimated??(mode==='manual'?1:0),now,now),db.prepare('UPDATE settings SET data_revision=data_revision+1 WHERE id=1'),readEntry(db,b.id),readRevision(db)]); }
  catch(e) {const duplicate=await get(db,b.id); if(duplicate)return result(db,b.id,'existing'); const active=await db.prepare('SELECT * FROM entries WHERE ended_at IS NULL').first(); if(active && end===null) return fail('ACTIVE_ENTRY_EXISTS','Уже есть активное обращение',409,{active_entry:expose(active),...await revision(db)}); throw e;}
  return json({entry:entryFrom(written[2]),operation_result:'applied',...revisionFrom(written[3])});
 }
 if(method==='POST' && path==='/api/entries/switch') {
  const b=await request.json(); if(!UUID.test(b.new_entry_id) || !UUID.test(b.expected_id) || !Number.isInteger(b.expected_revision)) throw Error('Некорректный запрос');
  if(await get(db,b.new_entry_id)) return json({new_entry:expose(await get(db,b.new_entry_id)),operation_result:'existing',...await revision(db)});
  const old=await get(db,b.expected_id); if(!old || old.ended_at!==null || old.revision!==b.expected_revision) return conflict(db,b.expected_id);
  let at=b.switch_at, adjusted=false; if(at<old.started_at && old.started_at-at<=2000){at=old.started_at;adjusted=true;} checkTime(old.started_at,at);
  const p=patch(b.closing_patch||{}), n=patch(b.preset||{}), now=Date.now(); if(adjusted)p.time_estimated=1;
  const sets=Object.keys(p).map(k=>`${k}=?`); const updates=[...Object.values(p)];
  const q1=db.prepare(`UPDATE entries SET ended_at=?,updated_at=?,revision=revision+1${sets.length?','+sets.join(','):''} WHERE id=? AND revision=? AND ended_at IS NULL`).bind(at,now,...updates,b.expected_id,b.expected_revision);
  const q2=db.prepare("INSERT INTO entries(id,started_at,ended_at,source_name,kind,note,why_me,capture_mode,time_estimated,created_at,updated_at) SELECT ?,?,NULL,?,?,?,?, 'timer',?,?,? WHERE changes()=1").bind(b.new_entry_id,at,n.source_name??null,n.kind??'unknown',n.note??null,n.why_me??null,adjusted?1:(n.time_estimated??0),now,now);
  let res; try {res=await db.batch([q1,q2,db.prepare('UPDATE settings SET data_revision=data_revision+1 WHERE id=1 AND changes()=1'),readEntry(db,b.expected_id),readEntry(db,b.new_entry_id),readRevision(db)]); if(!res[0].meta.changes){if(await get(db,b.new_entry_id))return json({new_entry:expose(await get(db,b.new_entry_id)),operation_result:'existing',...await revision(db)});return conflict(db,b.expected_id);}} catch(e) {if(await get(db,b.new_entry_id))return json({new_entry:expose(await get(db,b.new_entry_id)),operation_result:'existing',...await revision(db)});throw e;}
  return json({old_entry:entryFrom(res[3]),new_entry:entryFrom(res[4]),operation_result:'applied',time_adjusted:adjusted,...revisionFrom(res[5])});
 }
 if(match && ((['PATCH','DELETE'].includes(method) && !match[2]) || (method==='POST' && match[2]==='finish'))) {
  const id=match[1], b=await request.json(), old=await get(db,id); if(!old)return conflict(db,id);
  if(method==='POST' && match[2]==='finish' && old.ended_at!==null)return result(db,id,'already_finished');
  if(!Number.isInteger(b.expected_revision))throw Error('Укажите редакцию');
  const now=Date.now(); let sql, args, adjusted=false;
  if(method==='DELETE') {sql='DELETE FROM entries WHERE id=? AND revision=?';args=[id,b.expected_revision];}
  else {
   const p=patch(b.final_patch||b);
   if(method==='POST') {let end=b.clicked_ended_at; if(end<old.started_at && old.started_at-end<=2000){end=old.started_at;adjusted=true;p.time_estimated=1;} checkTime(old.started_at,end);p.ended_at=end;}
   else {if(Object.hasOwn(b,'started_at'))p.started_at=b.started_at;if(Object.hasOwn(b,'ended_at')) {if(old.ended_at===null || b.ended_at===null)throw Error('Нельзя изменить окончание активной записи');p.ended_at=b.ended_at;} checkTime(p.started_at??old.started_at,p.ended_at??old.ended_at,old.ended_at!==null);}
   const sets=Object.keys(p).map(k=>`${k}=?`); sql=`UPDATE entries SET ${sets.length?sets.join(',')+',':''}updated_at=?,revision=revision+1 WHERE id=? AND revision=?${method==='POST'?' AND ended_at IS NULL':''}`;args=[...Object.values(p),now,id,b.expected_revision];
  }
  const res=await db.batch([db.prepare(sql).bind(...args),db.prepare('UPDATE settings SET data_revision=data_revision+1 WHERE id=1 AND changes()=1'),readEntry(db,id),readRevision(db)]); if(!res[0].meta.changes)return conflict(db,id);
  return method==='DELETE'?json({operation_result:'applied',...revisionFrom(res[3])}):json({entry:entryFrom(res[2]),operation_result:'applied',time_adjusted:adjusted,...revisionFrom(res[3])});
 }
 return null;
 } catch(e) {if(e instanceof SyntaxError || e.message.startsWith('Некоррект') || e.message.startsWith('Укажите') || e.message.startsWith('Нельзя')) return fail('INVALID_INTERVAL',e.message,422); console.error('ENTRY_ERROR');return fail('INTERNAL_ERROR','Не удалось выполнить запрос',500);}
}
export {expose};
