import { test } from 'node:test';
import assert from 'node:assert/strict';

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}
globalThis.sessionStorage = storage();
globalThis.localStorage = storage();
const { EntryWriter } = await import('../frontend/public/js/store.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('быстрые правки и завершение сохраняются последовательно с временем клика', async () => {
  const calls = [], pending = [];
  const original = globalThis.fetch;
  globalThis.fetch = (path, options) => {
    calls.push({ path, method: options.method, body: JSON.parse(options.body) });
    return new Promise(resolve => pending.push(result => resolve(Response.json(result))));
  };
  try {
    const writer = new EntryWriter(() => {});
    writer.start({}, 1000);
    writer.update({kind: 'Проблема'});
    writer.update({kind: 'Координация'});
    writer.finish(1500);
    assert.equal(calls.length, 1);
    const id = calls[0].body.id;
    pending.shift()({entry: {id, revision: 1, started_at: 1000, ended_at: null}, operation_result: 'applied'});
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, 'PATCH');
    assert.equal(calls[1].body.kind, 'Координация');
    assert.equal(calls[1].body.expected_revision, 1);
    pending.shift()({entry: {id, revision: 2, started_at: 1000, ended_at: null}});
    await tick();
    assert.equal(calls.length, 3);
    assert.equal(calls[2].path, `/api/entries/${id}/finish`);
    assert.equal(calls[2].body.clicked_ended_at, 1500);
    assert.equal(calls[2].body.expected_revision, 2);
    pending.shift()({entry: {id, revision: 3, started_at: 1000, ended_at: 1500}});
    await tick();
    assert.equal(writer.draft, null);
  } finally { globalThis.fetch = original; }
});

test('новое значение во время PATCH не теряется после старого ответа', async () => {
  const calls = [], pending = [], original=globalThis.fetch;
  globalThis.fetch=(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return new Promise(resolve=>pending.push(value=>resolve(Response.json(value))));};
  try {
    const writer=new EntryWriter(()=>{}), id=crypto.randomUUID();
    writer.adopt({id,revision:1,started_at:1000,ended_at:null});
    writer.update({kind:'Проблема'});
    writer.update({kind:'Координация'});
    assert.equal(calls.length,1);
    pending.shift()({entry:{id,revision:2,started_at:1000,ended_at:null,kind:'Проблема'}});
    await tick();
    assert.equal(calls.length,2);
    assert.equal(calls[1].body.expected_revision,2);
    assert.equal(calls[1].body.kind,'Координация');
    pending.shift()({entry:{id,revision:3,started_at:1000,ended_at:null,kind:'Координация'}});
    await tick();
    assert.deepEqual(writer.draft.pending,{});
    writer.discard();
  } finally {globalThis.fetch=original;}
});

test('неизвестный исход switch восстанавливается тем же UUID и временем после перезагрузки', async () => {
  const calls=[], original=globalThis.fetch;
  const oldId=crypto.randomUUID();
  globalThis.fetch=async (path,options)=>{
    calls.push({path,body:JSON.parse(options.body)});
    if(calls.length===1)throw new Error('connection lost');
    return Response.json({operation_result:'existing',new_entry:{id:calls[1].body.new_entry_id,revision:1,started_at:1500,ended_at:null}});
  };
  try {
    const writer=new EntryWriter(()=>{});
    writer.adopt({id:oldId,revision:3,started_at:1000,ended_at:null});
    writer.switch(1500);
    await tick();
    assert.equal(writer.draft.error,'Не удалось связаться с приложением');
    assert.equal(calls[0].path,'/api/entries/switch');
    const restored=new EntryWriter(()=>{});
    assert.deepEqual(restored.draft.switch.payload,calls[0].body);
    restored.retry();
    await tick();
    assert.deepEqual(calls[1].body,calls[0].body);
    assert.equal(restored.draft.id,calls[0].body.new_entry_id);
    assert.equal(restored.draft.entry.started_at,1500);
    restored.discard();
  } finally {globalThis.fetch=original;}
});

test('восстановление create подтверждает совпавшие поля и сохраняет несовпавшие', async () => {
  const calls=[], original=globalThis.fetch;
  globalThis.fetch=async (path,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    if(calls.length===1)throw Error('lost');
    if(calls.length===2)return Response.json({operation_result:'existing',entry:{id:body.id,revision:1,started_at:1000,ended_at:null,source_name:'Глеб',kind:'Проблема'}});
    return Response.json({operation_result:'applied',entry:{id:body.id,revision:2,started_at:1000,ended_at:null,source_name:'Глеб',kind:'Координация'}});
  };
  try {
    const writer=new EntryWriter(()=>{});
    writer.start({source_name:'Глеб',kind:'Координация'},1000);
    await tick();
    const restored=new EntryWriter(()=>{});restored.retry();await tick();
    assert.equal(restored.draft.phase,'active');
    assert.deepEqual(restored.draft.pending,{kind:'Координация'});
    assert.match(restored.draft.error,/отличаются/);
    assert.equal(calls.length,2);
    restored.retry();await tick();
    assert.equal(calls.length,3);assert.equal(calls[2].expected_revision,1);assert.equal(calls[2].kind,'Координация');
    assert.deepEqual(restored.draft.pending,{});restored.discard();
  } finally {globalThis.fetch=original;}
});
