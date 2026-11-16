import {authenticate,checkMutation} from './auth.js';
import {handleEntries,expose} from './entries.js';
import {handleReports} from './reports.js';
import {handleExport} from './export.js';
import {bounds,metrics} from './calendar.js';
const json=(x,status=200)=>Response.json(x,{status,headers:{'Cache-Control':'no-store'}});
const err=(code,message,status=400,extra={})=>json({error:{code,message},...extra},status);
const exposeSettings=(s,env)=>({...s,pinned_actions:JSON.parse(s.pinned_actions_json),has_key:!!env.LLM_API_KEY});
const settings=async env=>exposeSettings(await env.DB.prepare('SELECT * FROM settings WHERE id=1').first(),env);
function requireTimezone(s,tz,env){if(s.timezone!==tz){const e=new Error('TIMEZONE_CHANGED');e.currentSettings=exposeSettings(s,env);throw e;}}
async function periodData(env,date,tz,kind='day') {
 const b=bounds(date,tz,kind);
 const [e,n,s]=await env.DB.batch([env.DB.prepare('SELECT * FROM entries WHERE (started_at < ? AND (ended_at IS NULL OR ended_at > ?)) OR (started_at >= ? AND started_at < ? AND ended_at = started_at) ORDER BY started_at DESC,id DESC').bind(b.end,b.start,b.start,b.end),env.DB.prepare('SELECT * FROM day_notes WHERE date>=? AND date<? ORDER BY date').bind(b.from,b.to),env.DB.prepare('SELECT * FROM settings WHERE id=1')]);
 const entries=e.results.map(expose), notes=n.results, st=s.results[0];
 requireTimezone(st,tz,env);
 return {entries,notes,metrics:metrics(entries,notes,b,tz),data_revision:st.data_revision, bounds:b};
}
export default {async fetch(request,env,ctx) {
 const url=new URL(request.url), path=url.pathname;
 if(!path.startsWith('/api/')) return env.ASSETS.fetch(request);
 try {
 const auth=await authenticate(request,env);if(auth)return auth;
 if(!['GET','HEAD'].includes(request.method)){const blocked=checkMutation(request);if(blocked)return blocked;}
 const exported=await handleExport(request,env);if(exported)return exported;
 const report=await handleReports(request,env,{getReportSnapshot:async(kind,date,tz)=>{const x=await periodData(env,date,tz,kind);return x.entries.length||x.notes.length?x:null;}}); if(report)return report;
 const handled=await handleEntries(request,env);if(handled)return handled;
 const db=env.DB, method=request.method;
 if(path==='/api/settings'&&method==='GET')return json(await settings(env));
 if(path==='/api/settings'&&method==='PATCH') {
  const b=await request.json(), current=await settings(env), allowed=['timezone','analysis_context','llm_provider','llm_base_url','llm_model'];
  if(b.timezone)bounds('2026-01-01',b.timezone);
  const values={};for(const k of allowed)if(Object.hasOwn(b,k)){if(b[k]!==null&&(typeof b[k]!=='string'||b[k].length>2000))throw Error('INVALID_SETTINGS');values[k]=b[k];}
  if(Object.hasOwn(b,'pinned_actions')){
   const kinds=['Согласование','Проблема','Координация','Сделать руками','Сам отвлёкся','Другое'];
   if(!Array.isArray(b.pinned_actions)||b.pinned_actions.length>50)throw Error('INVALID_SETTINGS');
   const pins=b.pinned_actions.map(p=>{if(!p||typeof p!=='object'||Array.isArray(p)||typeof p.label!=='string'||!p.label.trim()||p.label.length>80||!(p.source_name==null||(typeof p.source_name==='string'&&p.source_name.length<=80))||!(p.kind==null||kinds.includes(p.kind)))throw Error('INVALID_SETTINGS');return {label:p.label.trim(),source_name:p.source_name?.trim()||null,kind:p.kind||null};});
   values.pinned_actions_json=JSON.stringify(pins);
  }
  const cols=Object.keys(values);if(!cols.length)return json(current);
  const r=await db.batch([db.prepare(`UPDATE settings SET ${cols.map(k=>`${k}=?`).join(',')},revision=revision+1,data_revision=data_revision+1 WHERE id=1 AND revision=?`).bind(...Object.values(values),b.expected_revision),db.prepare('SELECT * FROM settings WHERE id=1')]);
  if(!r[0].meta.changes)return err('SETTINGS_CHANGED','Настройки изменены',409,{settings:await settings(env)});return json(await settings(env));
 }
 if(path==='/api/snapshot'&&method==='GET') {
  const date=url.searchParams.get('date'),tz=url.searchParams.get('timezone'),b=bounds(date,tz);
  const [e,n,a,s]=await db.batch([db.prepare('SELECT * FROM entries WHERE (started_at<? AND (ended_at IS NULL OR ended_at>?)) OR (started_at>=? AND started_at<? AND ended_at=started_at) ORDER BY started_at DESC,id DESC').bind(b.end,b.start,b.start,b.end),db.prepare('SELECT * FROM day_notes WHERE date=?').bind(date),db.prepare('SELECT * FROM entries WHERE ended_at IS NULL'),db.prepare('SELECT * FROM settings WHERE id=1')]);
  const st=s.results[0];requireTimezone(st,tz,env);return json({query_key:url.search,entries:e.results.map(expose),day_note:n.results[0]||null,active_entry:expose(a.results[0])||null,settings:exposeSettings(st,env),data_revision:st.data_revision,server_now:Date.now()});
 }
 if(path==='/api/stats'&&method==='GET'){const kind=url.searchParams.get('kind')==='week'?'week':'day';return json(await periodData(env,url.searchParams.get('date'),url.searchParams.get('timezone'),kind));}
 if(path==='/api/entries'&&method==='GET') {
  const tz=url.searchParams.get('timezone'),from=bounds(url.searchParams.get('from'),tz).start,to=bounds(url.searchParams.get('to'),tz).start,limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||50));
  let cursor=null;try{if(url.searchParams.get('cursor'))cursor=JSON.parse(atob(url.searchParams.get('cursor')));}catch{return err('INVALID_CURSOR','Некорректная страница');}
  const src=url.searchParams.get('source'),kind=url.searchParams.get('kind'),q=url.searchParams.get('q');
  const [e,s]=await db.batch([db.prepare(`SELECT * FROM entries WHERE ((started_at<? AND (ended_at IS NULL OR ended_at>?)) OR (started_at>=? AND started_at<? AND ended_at=started_at)) AND (? IS NULL OR source_name=?) AND (? IS NULL OR kind=?) AND (? IS NULL OR instr(lower(coalesce(note,'')),lower(?))>0) AND (? IS NULL OR started_at<? OR (started_at=? AND id<?)) ORDER BY started_at DESC,id DESC LIMIT ?`).bind(to,from,from,to,src,src,kind,kind,q,q,cursor?.[0]??null,cursor?.[0]??null,cursor?.[0]??null,cursor?.[1]??null,limit+1),db.prepare('SELECT * FROM settings WHERE id=1')]);
  requireTimezone(s.results[0],tz,env);
  const more=e.results.length>limit, rows=e.results.slice(0,limit),last=rows.at(-1);return json({entries:rows.map(expose),has_more:more,next_cursor:more?btoa(JSON.stringify([last.started_at,last.id])):null,data_revision:s.results[0].data_revision,query_key:url.search});
 }
 const note=path.match(/^\/api\/day-notes\/(\d{4}-\d{2}-\d{2})$/);
 if(note&&method==='GET')return json({day_note:await db.prepare('SELECT * FROM day_notes WHERE date=?').bind(note[1]).first()});
 if(note&&method==='PUT') {
  const b=await request.json(),st=await settings(env),range=bounds(note[1],st.timezone);for(const k of ['planned_minutes','available_minutes'])if(b[k]!=null&&(!Number.isInteger(b[k])||b[k]<0||b[k]>(range.end-range.start)/60000))throw Error('INVALID_NOTE');
  if(!['unknown','partial','full'].includes(b.coverage||'unknown')||typeof (b.outcomes_note??'')!=='string'||(b.outcomes_note||'').length>2000)throw Error('INVALID_NOTE');
  const old=await db.prepare('SELECT * FROM day_notes WHERE date=?').bind(note[1]).first();
  if((old?.revision??0)!==b.expected_revision)return err('NOTE_CHANGED','Контекст дня изменён',409,{day_note:old});
  const op=db.prepare(`INSERT INTO day_notes(date,planned_minutes,available_minutes,outcomes_note,coverage,updated_at,revision) VALUES(?,?,?,?,?,?,1) ON CONFLICT(date) DO UPDATE SET planned_minutes=excluded.planned_minutes,available_minutes=excluded.available_minutes,outcomes_note=excluded.outcomes_note,coverage=excluded.coverage,updated_at=excluded.updated_at,revision=day_notes.revision+1 WHERE day_notes.revision=?`).bind(note[1],b.planned_minutes??null,b.available_minutes??null,b.outcomes_note??null,b.coverage||'unknown',Date.now(),b.expected_revision);
  const res=await db.batch([op,db.prepare('UPDATE settings SET data_revision=data_revision+1 WHERE id=1 AND changes()=1')]);if(!res[0].meta.changes)return err('NOTE_CHANGED','Контекст дня изменён',409);return json({day_note:await db.prepare('SELECT * FROM day_notes WHERE date=?').bind(note[1]).first(),data_revision:(await settings(env)).data_revision});
 }
 return err('NOT_FOUND','Маршрут не найден',404);
 }catch(e){if(e?.message==='TIMEZONE_CHANGED')return err('TIMEZONE_CHANGED','Часовой пояс изменён на другом устройстве',409,{settings:e.currentSettings});console.error('API_ERROR',e?.name);return err('INVALID_REQUEST','Не удалось обработать запрос',400);}
}};
