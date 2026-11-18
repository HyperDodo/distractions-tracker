import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../backend/worker.js';
import {handleEntries} from '../backend/entries.js';

// SQLite-backed D1 adapter tests the HTTP contract locally; it is not a real D1 test.
function database() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_init.sql','0002_reports.sql','0003_sync.sql','0004_llm.sql']) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  let afterBatch;
  return {
    setAfterBatch(fn) {afterBatch = fn;},
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return {results: stmt.all(...args)}; },
        async run() { const r=stmt.run(...args); return {meta:{changes:Number(r.changes)}}; },
        async execute() { return stmt.columns().length ? this.all() : this.run(); }
      };
    },
    async batch(queries) {
      db.exec('BEGIN');
      try {const out=[]; for(const q of queries) {
        // A SELECT has columns while INSERT/UPDATE/DELETE has none.
        const result = await q.execute();
        out.push(result);
      } db.exec('COMMIT'); if(afterBatch) {const fn=afterBatch;afterBatch=null;fn(db);} return out;} catch (e) {db.exec('ROLLBACK'); throw e;}
    }
  };
}
const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url');
async function auth() {
  const key = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',hash:'SHA-256',modulusLength:2048,publicExponent:new Uint8Array([1,0,1])},true,['sign','verify']);
  const jwk = await crypto.subtle.exportKey('jwk',key.publicKey); jwk.kid='test-key'; jwk.alg='RS256';
  const issuer='https://integration-test.cloudflareaccess.com', email='owner@example.test', aud='test-audience';
  const header=enc({alg:'RS256',kid:jwk.kid}), payload=enc({iss:issuer,aud:[aud],email,exp:Math.floor(Date.now()/1000)+60});
  const message=`${header}.${payload}`;
  const signature=Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,new TextEncoder().encode(message))).toString('base64url');
  return {jwk, issuer,email,aud, token:`${message}.${signature}`};
}
test('API: start, optimistic conflict, finish, snapshot and timezone change', async () => {
  const a=await auth(), oldFetch=globalThis.fetch;
  globalThis.fetch=async () => Response.json({keys:[a.jwk]});
  try {
    const env={DB:database(),ACCESS_TEAM_DOMAIN:a.issuer,ACCESS_AUD:a.aud,ACCESS_EMAIL:a.email};
    async function call(path,method='GET',body) {
      const headers={'Cf-Access-Jwt-Assertion':a.token};
      if(body!==undefined){headers.Origin='https://tracker.test';headers['Content-Type']='application/json';}
      const response=await worker.fetch(new Request('https://tracker.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),env,{});
      return {status:response.status,body:await response.json()};
    }
    const id=crypto.randomUUID(), timestamp=Date.now()-10000;
    const created=await call('/api/entries','POST',{id,mode:'timer',started_at:timestamp});
    assert.equal(created.status,200);assert.equal(created.body.entry.id,id);
    const edited=await call(`/api/entries/${id}`,'PATCH',{expected_revision:1,kind:'Проблема'});
    assert.equal(edited.body.entry.revision,2);
    const conflict=await call(`/api/entries/${id}`,'PATCH',{expected_revision:1,note:'old'});
    assert.equal(conflict.status,409);
    const finished=await call(`/api/entries/${id}/finish`,'POST',{expected_revision:2,clicked_ended_at:timestamp+5000});
    assert.equal(finished.body.entry.ended_at,timestamp+5000);
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(timestamp);
    const snapshot=await call(`/api/snapshot?date=${date}&timezone=Europe%2FMoscow`);
    assert.equal(snapshot.status,200);assert.equal(snapshot.body.entries[0].kind,'Проблема');assert.equal(snapshot.body.active_entry,null);
    const wrong=await call(`/api/snapshot?date=${date}&timezone=UTC`);
    assert.equal(wrong.status,409);assert.equal(wrong.body.error.code,'TIMEZONE_CHANGED');assert.equal(wrong.body.settings.timezone,'Europe/Moscow');
    const replicated=await call('/api/sync?after=0');
    assert.equal(replicated.status,200);
    assert.equal(replicated.body.changes.find(change=>change.id===id).value.ended_at,timestamp+5000);
    const rejected=await worker.fetch(new Request('https://tracker.test/api/sync?after=0'),env,{});
    assert.equal(rejected.status,401);
  } finally {globalThis.fetch=oldFetch;}
});

test('mutation response contains entry and revision from its own transaction', async () => {
 const db=database(), id=crypto.randomUUID(), started=Date.now()-1000;
 db.setAfterBatch(raw=>{raw.prepare("UPDATE entries SET note='concurrent', revision=revision+1 WHERE id=?").run(id);raw.exec('UPDATE settings SET data_revision=data_revision+1');});
 const request=new Request('https://tracker.test/api/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,mode:'timer',started_at:started})});
 const response=await handleEntries(request,{DB:db}), body=await response.json();
 assert.equal(body.entry.note,null);assert.equal(body.entry.revision,1);assert.equal(body.data_revision,1);
 const current=await db.prepare('SELECT note,revision FROM entries WHERE id=?').bind(id).first();assert.equal(current.note,'concurrent');assert.equal(current.revision,2);
});
