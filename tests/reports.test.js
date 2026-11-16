import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleReports } from '../backend/reports.js';

test('one report ID triggers at most one external request and deletion blocks resurrection', async () => {
  const sql = new DatabaseSync(':memory:');
  for (const path of ['migrations/0001_init.sql', 'migrations/0002_reports.sql']) sql.exec(readFileSync(path, 'utf8'));
  sql.exec("UPDATE settings SET llm_model='example'");
  const DB = { prepare(query) { return { async first() { return sql.prepare(query).get() ?? null; }, bind(...args) { return {
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async run() { return { meta: { changes: Number(sql.prepare(query).run(...args).changes) } }; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
  }; } }; } };
  const env = { DB, LLM_API_KEY: 'test-secret' };
  const id = '8333ab00-9a76-4e40-837a-b563c65222ee';
  const request = () => new Request('https://example.com/api/llm/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report_id: id }) });
  const original = globalThis.fetch;
  let calls = 0, release;
  globalThis.fetch = async () => { calls++; await new Promise(resolve => { release = resolve; }); return Response.json({ choices: [{ message: { content: 'OK' } }] }); };
  try {
    const first = handleReports(request(), env, {});
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    const duplicate = await handleReports(request(), env, {});
    assert.equal(duplicate.status, 202);
    assert.equal(calls, 1);
    release();
    assert.equal((await first).status, 200);
    const row = sql.prepare('SELECT * FROM reports WHERE id=?').get(id);
    const deleted = await handleReports(new Request(`https://example.com/api/reports/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_status: row.status, expected_updated_at: row.updated_at }) }), env, {});
    assert.equal(deleted.status, 200);
    assert.equal((await handleReports(request(), env, {})).status, 410);
    assert.equal(calls, 1);
    assert.equal(sql.prepare('SELECT result_json FROM reports WHERE id=?').get(id).result_json, null);
  } finally { release?.(); globalThis.fetch = original; sql.close(); }
});
