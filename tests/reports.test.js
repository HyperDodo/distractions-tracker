import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleExport } from '../backend/export.js';
import { handleLlmConfig } from '../backend/llm.js';
import { handleReports } from '../backend/reports.js';

const secret = 'fallback-test-key';
const encryptionKey = btoa('0123456789abcdefghijklmnopqrstuv');
const configRequest = (method, body) => new Request('https://tracker.example.com/api/llm/config', {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const testRequest = (id = crypto.randomUUID()) => new Request('https://tracker.example.com/api/llm/test', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report_id: id }),
});
const reportRequest = (id = crypto.randomUUID()) => new Request('https://tracker.example.com/api/reports', {
  method: 'POST', body: JSON.stringify({ report_id: id, kind: 'day', date: '2026-10-25', timezone: 'UTC' }),
});
const reportContext = { getReportSnapshot: () => ({ entries: [{ id: 'example' }], metrics: {} }) };

function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  for (const path of ['migrations/0001_init.sql', 'migrations/0002_reports.sql', 'migrations/0004_llm.sql']) {
    sql.exec(readFileSync(path, 'utf8'));
  }
  const DB = { prepare(query) {
    const statement = sql.prepare(query);
    const queryWith = args => ({
      bind(...values) { return queryWith(values); },
      async first() { return statement.get(...args) ?? null; },
      async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
      async all() { return { results: statement.all(...args) }; },
    });
    return queryWith([]);
  } };
  return { sql, env: { DB, OPENROUTER_FREE_API_KEY: secret, LLM_TOKEN_ENCRYPTION_KEY: encryptionKey } };
}

test('one report ID triggers at most one external request and deletion blocks resurrection', async t => {
  const { sql, env } = fixture(t);
  const id = '8333ab00-9a76-4e40-837a-b563c65222ee';
  const original = globalThis.fetch;
  let calls = 0, release;
  globalThis.fetch = async () => { calls++; await new Promise(resolve => { release = resolve; }); return Response.json({ choices: [{ message: { content: 'OK' } }] }); };
  try {
    const first = handleReports(testRequest(id), env, {});
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    const duplicate = await handleReports(testRequest(id), env, {});
    assert.equal(duplicate.status, 202);
    assert.equal(calls, 1);
    release();
    assert.equal((await first).status, 200);
    const row = sql.prepare('SELECT * FROM reports WHERE id=?').get(id);
    const deleted = await handleReports(new Request(`https://example.com/api/reports/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_status: row.status, expected_updated_at: row.updated_at }) }), env, {});
    assert.equal(deleted.status, 200);
    assert.equal((await handleReports(testRequest(id), env, {})).status, 410);
    assert.equal(calls, 1);
    assert.equal(sql.prepare('SELECT result_json FROM reports WHERE id=?').get(id).result_json, null);
  } finally { release?.(); globalThis.fetch = original; }
});

test('free OpenRouter uses the dedicated secret and a fixed endpoint, and stops at a redirect', async t => {
  const { sql, env } = fixture(t);
  sql.exec("UPDATE settings SET llm_base_url='https://other.example.com/v1', llm_model='paid' WHERE id=1");
  const legacyEnv = { ...env, OPENROUTER_FREE_API_KEY: undefined, LLM_API_KEY: 'legacy-test-key' };
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.redirect('https://other.example.com/v1/chat/completions', 307);
  };
  try {
    const unavailable = await handleReports(testRequest(), legacyEnv, {});
    assert.equal((await unavailable.json()).error.code, 'LLM_NOT_CONFIGURED');
    assert.equal(calls.length, 0);
    const result = await handleReports(reportRequest(), env, reportContext);
    const { report } = await result.json();
    assert.equal(report.status, 'failed');
    assert.equal(report.error_code, 'PROVIDER_REDIRECT');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(calls[0].options.redirect, 'manual');
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.model, 'openrouter/free');
    assert.equal(payload.response_format.type, 'json_schema');
  } finally { globalThis.fetch = original; }
});

test('connection probes accept compatible completions without storing the provider response', async t => {
  const { env } = fixture(t);
  const fixtureText = 'upstream-private-content';
  const responses = [
    [{ message: { content: fixtureText } }, null],
    [{ message: { role: 'assistant', content: null }, finish_reason: 'length' }, null],
    [{ message: { role: 'assistant', content: '', reasoning: fixtureText }, finish_reason: 'stop' }, null],
    [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }, 'INVALID_MODEL_RESULT'],
    [{ message: { role: 'assistant', content: fixtureText, refusal: 'declined' } }, 'INVALID_MODEL_RESULT'],
    [{ message: { content: fixtureText }, finish_reason: 'content_filter' }, 'INVALID_MODEL_RESULT'],
    [{ message: { role: 'assistant', content: fixtureText }, error: { message: fixtureText } }, 'PROVIDER_ERROR'],
  ];
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider call'); });
  for (const [choice, error] of responses) {
    fetch.mock.mockImplementationOnce(async () => Response.json({
      choices: [choice], usage: { prompt_tokens: 4, completion_tokens: 12, cost: 0 },
    }));
    const response = await handleReports(testRequest(), env, {});
    const text = await response.text();
    const { report } = JSON.parse(text);
    assert.equal(report.status, error ? 'failed' : 'completed');
    assert.equal(report.error_code, error);
    assert.equal(report.result_json, error ? null : JSON.stringify({ message: 'OK' }));
    assert.deepEqual([report.input_tokens, report.output_tokens, report.cost], [4, 12, 0]);
    assert.ok(!text.includes(fixtureText));
  }
  assert.equal(fetch.mock.callCount(), responses.length);
  const payload = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.equal(payload.max_tokens, 128);
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'Respond OK.' }]);
});

test('a known bad provider response stays distinct from invalid model output and transport failures', async t => {
  const { env } = fixture(t);
  const fixtureText = 'upstream-private-content';
  const responses = [
    [() => new Response(`<html>${fixtureText}</html>`), 'failed', 'INVALID_PROVIDER_RESPONSE'],
    [() => Response.json({ choices: [{ message: null }] }), 'failed', 'INVALID_PROVIDER_RESPONSE'],
    [() => Response.json({ choices: [{ message: { content: fixtureText } }] }), 'failed', 'INVALID_MODEL_JSON'],
    [() => { throw new TypeError(fixtureText); }, 'unknown', 'PROVIDER_UNREACHABLE'],
    [() => { throw new DOMException(fixtureText, 'AbortError'); }, 'unknown', 'TIMEOUT'],
  ];
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider call'); });
  for (const [reply, status, error] of responses) {
    fetch.mock.mockImplementationOnce(reply);
    const id = crypto.randomUUID();
    const response = await handleReports(reportRequest(id), env, reportContext);
    const text = await response.text();
    const { report } = JSON.parse(text);
    assert.equal(report.status, status);
    assert.equal(report.error_code, error);
    assert.equal(report.result_json, null);
    assert.ok(!text.includes(fixtureText));
    const retry = await handleReports(reportRequest(id), env, reportContext);
    assert.equal((await retry.json()).report.error_code, error);
  }
  assert.equal(fetch.mock.callCount(), responses.length);
});

test('the chosen connection is encrypted, its destination binds the token, and a provider error stays with it', async t => {
  const { sql, env } = fixture(t);
  const token = 'owned-provider-test-token';
  const connection = { provider: 'custom', base_url: 'https://provider.example.com/v1/', model: 'model-a' };
  for (const base_url of ['http://provider.example.com/v1', 'https://127.0.0.1/v1', 'https://office.local/v1', 'https://tracker.example.com/v1', 'https://provider.example.com/v1?key=bad']) {
    const rejected = await handleLlmConfig(configRequest('PUT', { ...connection, base_url, token }), env);
    assert.equal((await rejected.json()).error.code, 'INVALID_LLM_URL');
  }
  const missingToken = await handleLlmConfig(configRequest('PUT', connection), env);
  assert.equal((await missingToken.json()).error.code, 'LLM_TOKEN_REQUIRED');
  const missingStorage = await handleLlmConfig(configRequest('PUT', { ...connection, token }), { ...env, LLM_TOKEN_ENCRYPTION_KEY: '' });
  assert.equal(missingStorage.status, 503);
  const saved = await handleLlmConfig(configRequest('PUT', { ...connection, token }), env);
  assert.deepEqual(await saved.json(), {
    provider: 'custom', base_url: 'https://provider.example.com/v1', model: 'model-a', has_token: true, free_available: true,
  });
  const encrypted = sql.prepare('SELECT encrypted_token FROM llm_config WHERE id=1').get().encrypted_token;
  assert.ok(!encrypted.includes(token));
  const updated = await handleLlmConfig(configRequest('PUT', { ...connection, model: 'model-b', token: '' }), env);
  assert.equal((await updated.json()).model, 'model-b');
  assert.equal(sql.prepare('SELECT encrypted_token FROM llm_config WHERE id=1').get().encrypted_token, encrypted);
  const changed = await handleLlmConfig(configRequest('PUT', { ...connection, base_url: 'https://other.example.com/v1' }), env);
  assert.equal((await changed.json()).error.code, 'LLM_TOKEN_REQUIRED');
  const exported = await handleExport(new Request('https://tracker.example.com/api/export?format=json'), env);
  const text = await exported.text();
  assert.ok(!text.includes(token) && !text.includes(encrypted));
  assert.equal(JSON.parse(text).settings.llm_model, 'model-b');

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 429 });
  };
  try {
    const result = await handleReports(testRequest(), env, {});
    assert.equal((await result.json()).report.error_code, 'PROVIDER_HTTP_429');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://provider.example.com/v1/chat/completions');
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
    assert.equal(JSON.parse(calls[0].options.body).model, 'model-b');
    const unreadable = await handleReports(testRequest(), { ...env, LLM_TOKEN_ENCRYPTION_KEY: btoa('abcdefghijklmnopqrstuvwxyz012345') }, {});
    assert.equal((await unreadable.json()).error.code, 'LLM_TOKEN_UNAVAILABLE');
    assert.equal(calls.length, 1);
    const preset = await handleLlmConfig(configRequest('PUT', { provider: 'cheapai', model: 'model-c', base_url: connection.base_url, token }), env);
    assert.equal((await preset.json()).base_url, 'https://cheapai.io/v1');
    const deleted = await handleLlmConfig(configRequest('DELETE'), env);
    assert.equal((await deleted.json()).provider, null);
    await handleReports(testRequest(), env, {});
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[1].options.headers.Authorization, `Bearer ${secret}`);
  } finally { globalThis.fetch = original; }
});
