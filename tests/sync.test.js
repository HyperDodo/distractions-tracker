import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleSync} from '../backend/sync.js';
import {handleEntries} from '../backend/entries.js';

function setup(seed = () => {}) {
 const raw = new DatabaseSync(':memory:');
 function migrate(name) {raw.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));}
 migrate('0001_init.sql');
 migrate('0002_reports.sql');
 seed(raw);
 migrate('0003_sync.sql');
 let afterBatch;
 const DB = {
  prepare(sql) {
   const statement = raw.prepare(sql);
   let values = [];
   return {
    bind(...args) {values = args; return this;},
    first: async () => statement.get(...values) ?? null,
    all: async () => ({results:statement.all(...values)}),
    execute() {
     if (statement.columns().length) return {results:statement.all(...values)};
     return {meta:{changes:Number(statement.run(...values).changes)}};
    }
   };
  },
  async batch(queries) {
   raw.exec('BEGIN');
   let results;
   try {
    results = queries.map(query=>query.execute());
    raw.exec('COMMIT');
   } catch (error) {raw.exec('ROLLBACK'); throw error;}
   if (afterBatch) {const update = afterBatch; afterBatch = null; update(raw);}
   return results;
  }
 };
 async function call(path, operation, handler = handleSync) {
  const method = operation ? 'POST' : 'GET';
  const response = await handler(new Request(`https://tracker.test${path}`,{method,body:operation ? JSON.stringify(operation) : undefined}),{DB});
  return {status:response.status,body:await response.json()};
 }
 return {
  raw, DB, call,
  afterNextBatch(fn) {afterBatch = fn;},
  pull: (after=0, through) => call(`/api/sync?after=${after}${through == null ? '' : `&through=${through}`}`),
  push: (type,payload,operation_id=crypto.randomUUID()) => call('/api/sync',{operation_id,type,payload})
 };
}

const newId = () => crypto.randomUUID();
const started = Date.now() - 100000;
const historyEntry = id => ({id,mode:'timer',started_at:started,ended_at:started+1000});

test('sync bootstraps legacy D1 rows and returns public settings and report fields', async () => {
 const entry = newId(), report = newId(), date = '2026-11-01';
 const {pull} = setup(db=>{
  db.prepare("INSERT INTO entries(id,started_at,ended_at,capture_mode,time_estimated,created_at,updated_at) VALUES (?,?,?,'manual',1,?,?)").run(entry,started,started+1000,started,started);
  db.prepare('INSERT INTO day_notes(date,updated_at) VALUES (?,?)').run(date,started);
  db.prepare("INSERT INTO reports(id,kind,status,date_from,date_to_exclusive,timezone,created_at,updated_at,provider,model,prompt_version,input_snapshot_json,result_json) VALUES (?,'day','completed',?,'2026-11-02','UTC',?,?,'openrouter','model','1','{}','{}')").run(report,date,started,started);
 });
 const {status,body} = await pull();
 assert.equal(status,200);
 assert.equal(body.cursor,body.through);
 assert.equal(body.has_more,false);
 assert.deepEqual(body.changes.map(change=>[change.kind,change.id]),[['settings','1'],['entry',entry],['day_note',date],['report',report]]);
 assert.deepEqual(Object.keys(body.changes[0].value).sort(),['analysis_context','data_revision','id','pinned_actions','revision','timezone']);
 assert.equal(body.changes[1].value.estimated,true);
 assert.equal(body.changes[1].value.mode,'manual');
 assert.equal(body.changes[3].value.result_json,'{}');
 assert.equal(Object.hasOwn(body.changes[3].value,'input_snapshot_json'),false);
});

test('offline operations reconcile exactly once, preserve click timestamps and report current conflicts', async () => {
 const {pull,push,raw} = setup();
 const active = newId(), other = newId(), archived = newId(), next = newId(), op = newId();
 const create = {id:active,started_at:started};
 const first = await push('entry.create',create,op);
 assert.equal(first.status,200);
 assert.equal(first.body.changes[0].value.revision,1);
 assert.equal(first.body.changes[0].value.ended_at,null);
 const colliding = await push('entry.create',{id:other,started_at:started});
 assert.equal(colliding.status,409);
 assert.equal(colliding.body.error.code,'ACTIVE_ENTRY_EXISTS');
 assert.equal(colliding.body.changes.find(change=>change.value).id,active);
 const historical = await push('entry.create',historyEntry(archived));
 assert.equal(historical.status,200);
 const moved = await push('entry.switch',{expected_id:active,expected_revision:1,new_entry_id:next,switch_at:started+2000});
 assert.equal(moved.status,200);
 assert.equal(moved.body.changes[0].value.ended_at,started+2000);
 assert.equal(moved.body.changes[1].value.started_at,started+2000);
 assert.equal(moved.body.changes[1].value.ended_at,null);
 assert.deepEqual(raw.prepare('SELECT id FROM entries WHERE ended_at IS NULL').all().map(row=>row.id),[next]);

 const replay = await push('entry.create',{started_at:started,id:active},op);
 assert.equal(replay.status,200);
 assert.equal(replay.body.through,first.body.through);
 assert.equal(replay.body.changes[0].value.revision,2);
 const reused = await push('entry.create',{...create,started_at:started+100},op);
 assert.equal(reused.status,409);
 assert.equal(reused.body.error.code,'ID_REUSE_CONFLICT');
 const stale = await push('entry.update',{id:active,expected_revision:1,note:'stale'});
 assert.equal(stale.status,409);
 assert.equal(stale.body.changes[0].value.note,null);

 const stopped = await push('entry.finish',{id:next,expected_revision:1,clicked_ended_at:started+6500});
 assert.equal(stopped.status,200);
 assert.equal(stopped.body.changes[0].value.ended_at,started+6500);
 const removed = await push('entry.delete',{id:archived,expected_revision:1});
 assert.equal(removed.status,200);
 assert.deepEqual(removed.body.changes,[{id:archived,kind:'entry',seq:removed.body.through,value:null}]);
 const all = await pull();
 assert.equal(all.body.changes.filter(change=>change.kind==='entry').length,3);
 assert.equal(all.body.changes.find(change=>change.id===archived).value,null);
});

test('sync receipt and success rows come from the same transaction despite immediate remote edits', async () => {
 const {afterNextBatch,push} = setup(), id = newId();
 afterNextBatch(raw=>raw.prepare("UPDATE entries SET note='remote',revision=revision+1 WHERE id=?").run(id));
 const committed = await push('entry.create',historyEntry(id));
 assert.equal(committed.status,200);
 assert.equal(committed.body.changes[0].seq,committed.body.through);
 assert.equal(committed.body.changes[0].value.revision,1);
 assert.equal(committed.body.changes[0].value.note,null);
});

test('note and settings changes use expected revisions and track legacy writes without extra events', async () => {
 const {call,pull,push,raw} = setup(), date = '2026-11-08';
 const base = (await pull()).body.cursor;
 const note = {date,expected_revision:0,outcomes_note:'First',available_minutes:120};
 assert.equal((await push('day_note.put',note)).body.changes[0].value.revision,1);
 assert.equal((await push('day_note.put',{...note,expected_revision:1,outcomes_note:'Second'})).body.changes[0].value.revision,2);
 const stale = await push('day_note.put',note);
 assert.equal(stale.status,409);
 assert.equal(stale.body.changes[0].value.outcomes_note,'Second');
 assert.equal((await pull(base)).body.changes.length,1);
 const preference = await push('settings.patch',{expected_revision:1,timezone:'UTC',pinned_actions:[{label:'Звонок',kind:'Проблема'}]});
 assert.equal(preference.body.changes[0].value.timezone,'UTC');
 assert.deepEqual(preference.body.changes[0].value.pinned_actions,[{label:'Звонок',source_name:null,kind:'Проблема'}]);
 assert.equal((await push('settings.patch',{expected_revision:2,timezone:'Wrong/Zone'})).status,422);
 assert.equal((await push('settings.patch',{expected_revision:2,llm_model:'secret'})).status,422);
 const id = newId();
 assert.equal((await call('/api/entries',historyEntry(id),handleEntries)).status,200);
 const changes = (await pull(preference.body.through)).body.changes;
 assert.deepEqual(changes.map(change=>[change.kind,change.id]),[['entry',id]]);
 assert.equal(raw.prepare('SELECT count(*) AS count FROM sync_entities').get().count,3);
});

test('pull holds a bounded watermark while paginating and catches new changes on the next pull', async () => {
 const ids = Array.from({length:102},()=>newId());
 const {pull,push} = setup(raw=>{
  const insert = raw.prepare("INSERT INTO entries(id,started_at,ended_at,capture_mode,time_estimated,created_at,updated_at) VALUES (?,?,?,'timer',0,?,?)");
  for (const id of ids) insert.run(id,started,started+1000,started,started);
 });
 const first = (await pull()).body;
 assert.equal(first.has_more,true);
 assert.equal(first.changes.length,100);
 const lastId = ids.at(-1);
 await push('entry.update',{id:lastId,expected_revision:1,note:'later'});
 const second = (await pull(first.cursor,first.through)).body;
 assert.equal(second.has_more,false);
 assert.equal(second.cursor,first.through);
 assert.equal(second.changes.some(change=>change.id===lastId),false);
 const later = (await pull(second.cursor)).body;
 assert.equal(later.changes[0].value.note,'later');
 assert.equal((await pull(later.cursor+1)).body.error.code,'SYNC_CURSOR_EXPIRED');
});
