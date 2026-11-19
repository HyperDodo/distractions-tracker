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
  const config = await (await handleLlmConfig(configRequest('GET'), env)).json();
  assert.deepEqual([config.default_available, config.default_model, config.free_available], [true, 'openrouter/free', true]);
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

test('a complete built-in OpenRouter pair uses its own model and yields to a saved personal connection', async t => {
  const { env: legacy } = fixture(t);
  const defaultToken = 'built-in-openrouter-test-token';
  const personalToken = 'personal-cheapai-test-token';
  const model = 'openai/gpt-4.1-mini';
  const env = { ...legacy, OPENROUTER_DEFAULT_API_KEY: defaultToken, OPENROUTER_DEFAULT_MODEL: model };
  const expectedDefaults = { default_available: true, default_model: model, free_available: false };
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider call'); });

  const config = await handleLlmConfig(configRequest('GET'), env);
  assert.deepEqual(await config.json(), { provider: null, model: null, base_url: null, has_token: false, ...expectedDefaults });
  const withFreeModel = await handleLlmConfig(configRequest('GET'), { ...env, OPENROUTER_DEFAULT_MODEL: 'openrouter/free' });
  assert.deepEqual(await withFreeModel.json(), {
    provider: null, model: null, base_url: null, has_token: false, default_available: true, default_model: 'openrouter/free', free_available: true,
  });

  fetch.mock.mockImplementationOnce(() => Response.json({ choices: [{ message: { content: 'OK' } }] }));
  const builtIn = await handleReports(testRequest(), env, {});
  const { report: builtInReport } = await builtIn.json();
  assert.deepEqual([builtInReport.status, builtInReport.model], ['completed', model]);

  const saved = await handleLlmConfig(configRequest('PUT', { provider: 'cheapai', model: 'personal-model', token: personalToken }), env);
  assert.deepEqual(await saved.json(), {
    provider: 'cheapai', model: 'personal-model', base_url: 'https://cheapai.io/v1', has_token: true, ...expectedDefaults,
  });
  fetch.mock.mockImplementationOnce(() => new Response(null, { status: 401 }));
  const personal = await handleReports(testRequest(), env, {});
  const { report: personalReport } = await personal.json();
  assert.deepEqual([personalReport.status, personalReport.provider, personalReport.error_code], ['failed', 'cheapai', 'PROVIDER_HTTP_401']);

  const cleared = await handleLlmConfig(configRequest('DELETE'), env);
  assert.deepEqual(await cleared.json(), { provider: null, model: null, base_url: null, has_token: false, ...expectedDefaults });
  assert.deepEqual(fetch.mock.calls.map(({ arguments: [url, options] }) =>
    [url, options.headers.Authorization, JSON.parse(options.body).model]), [
    ['https://openrouter.ai/api/v1/chat/completions', `Bearer ${defaultToken}`, model],
    ['https://cheapai.io/v1/chat/completions', `Bearer ${personalToken}`, 'personal-model'],
  ]);
});

test('incomplete or invalid built-in bindings never mix with the legacy free credential', async t => {
  const { env: legacy } = fixture(t);
  const key = 'built-in-openrouter-test-token';
  const model = 'openai/gpt-4.1-mini';
  const cases = [
    { OPENROUTER_DEFAULT_API_KEY: key },
    { OPENROUTER_DEFAULT_MODEL: model },
    { OPENROUTER_DEFAULT_API_KEY: '', OPENROUTER_DEFAULT_MODEL: model },
    { OPENROUTER_DEFAULT_API_KEY: 'invalid key', OPENROUTER_DEFAULT_MODEL: model },
    ...['', ` ${model}`, `${model}\n`, 'openai/model with spaces', 'openai/model\u0007', 'x'.repeat(257), key].map(invalidModel =>
      ({ OPENROUTER_DEFAULT_API_KEY: key, OPENROUTER_DEFAULT_MODEL: invalidModel })),
  ];
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider call'); });
  for (const bindings of cases) {
    const env = { ...legacy, ...bindings };
    const config = await handleLlmConfig(configRequest('GET'), env);
    assert.deepEqual(await config.json(), {
      provider: null, model: null, base_url: null, has_token: false, default_available: false, default_model: null, free_available: false,
    });
    const result = await handleReports(testRequest(), env, {});
    assert.equal(result.status, 400);
    const { error } = await result.json();
    assert.equal(error.code, 'LLM_NOT_CONFIGURED');
    assert.match(error.message, /OPENROUTER_DEFAULT_API_KEY.*OPENROUTER_DEFAULT_MODEL/);
    assert.ok(!error.message.includes(key));
  }
  assert.equal(fetch.mock.callCount(), 0);
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

test('OpenRouter 403 details become safe codes without rerouting or retaining upstream text', async t => {
  const { sql, env } = fixture(t);
  const ownToken = 'personal-openrouter-test-token';
  const configured = await handleLlmConfig(configRequest('PUT', {
    provider: 'openrouter', model: 'openrouter/free', token: ownToken,
  }), env);
  assert.equal(configured.status, 200);

  const secretDetails = 'upstream-private-authorization-and-prompt';
  const cases = [
    [{ limit_source: 'openrouter_key_limit' }, 'Forbidden', 'OPENROUTER_403_KEY_LIMIT'],
    [{ limit_source: 'openrouter_workspace_budget' }, 'Forbidden', 'OPENROUTER_403_WORKSPACE_BUDGET'],
    [{ limit_source: 'openrouter_guardrail_budget' }, 'Forbidden', 'OPENROUTER_403_GUARDRAIL_BUDGET'],
    [{}, 'Budget limit exceeded (weekly limit).', 'OPENROUTER_403_BUDGET'],
    [{ error_type: 'permission_denied' }, 'Forbidden', 'OPENROUTER_403_PERMISSION'],
    [{}, 'This model is not allowed by the workspace.', 'OPENROUTER_403_PERMISSION'],
    [{ error_type: 'content_policy_violation' }, 'Forbidden', 'OPENROUTER_403_SAFETY'],
    [{ error_type: 'refusal' }, 'Forbidden', 'OPENROUTER_403_SAFETY'],
    [{ reasons: ['safety'], flagged_input: secretDetails }, 'Forbidden', 'OPENROUTER_403_SAFETY'],
    [{ error_type: 'permission_denied' }, 'Request blocked: prompt injection patterns detected', 'OPENROUTER_403_SAFETY'],
    [{ error_type: 'permission_denied' }, 'This request arrived on the global data region, but the key’s workspace permits requests only on these OpenRouter hostnames: eu.openrouter.ai.', 'OPENROUTER_403_REGION'],
    [{}, 'IP address is not on the allowlist.', 'OPENROUTER_403_REGION'],
    [{ limit_source: 'unrecognized_budget', error_type: 'constructor' }, 'Forbidden', 'PROVIDER_HTTP_403'],
  ];
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider call'); });
  for (const [metadata, message, expected] of cases) {
    fetch.mock.mockImplementationOnce(() => Response.json({ error: {
      code: 403, message: `${message} ${secretDetails}`, metadata: { ...metadata, raw: secretDetails },
    } }, { status: 403 }));
    const id = crypto.randomUUID();
    const response = await handleReports(reportRequest(id), env, reportContext);
    const text = await response.text();
    const { report } = JSON.parse(text);
    assert.deepEqual([report.status, report.error_code, report.result_json], ['failed', expected, null]);
    assert.ok(!text.includes(secretDetails) && !text.includes(ownToken));
    assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM reports WHERE id=?').get(id)).includes(secretDetails));
    const retry = await handleReports(reportRequest(id), env, reportContext);
    assert.equal((await retry.json()).report.error_code, expected);
  }
  assert.equal(fetch.mock.callCount(), cases.length);
  assert.ok(fetch.mock.calls.every(({ arguments: [url, options] }) =>
    url === 'https://openrouter.ai/api/v1/chat/completions' && options.headers.Authorization === `Bearer ${ownToken}`));
});

test('full-report and other-provider 403s do not run a credential check', async t => {
  const { env } = fixture(t);
  const providerBody = { error: { code: 403, metadata: { limit_source: 'openrouter_key_limit' } } };
  let cancelled = false;
  const oversizedBytes = new TextEncoder().encode(JSON.stringify({ ...providerBody, padding: '0'.repeat(8192) }));
  const unreadable = new Response(new ReadableStream({ start(stream) { stream.error(new Error('unreadable')); } }), { status: 403 });
  const oversized = new Response(new ReadableStream({
    start(stream) { stream.enqueue(oversizedBytes); },
    cancel() { cancelled = true; },
  }), { status: 403 });

  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider call'); });
  const originalResponses = [
    [new Response('<html>Forbidden</html>', { status: 403 }), 'OPENROUTER_403_NON_API'],
    [unreadable, 'PROVIDER_HTTP_403'], [oversized, 'PROVIDER_HTTP_403'],
  ];
  for (const [body, expected] of originalResponses) {
    fetch.mock.mockImplementationOnce(() => body);
    const response = await handleReports(reportRequest(), env, reportContext);
    const { report } = await response.json();
    assert.deepEqual([report.status, report.error_code], ['failed', expected]);
  }
  assert.equal(cancelled, true);

  const configured = await handleLlmConfig(configRequest('PUT', {
    provider: 'cheapai', model: 'model-c', token: 'cheapai-test-token',
  }), env);
  assert.equal(configured.status, 200);
  fetch.mock.mockImplementationOnce(() => Response.json(providerBody, { status: 403 }));
  const response = await handleReports(testRequest(), env, {});
  const { report } = await response.json();
  assert.deepEqual([report.status, report.error_code], ['failed', 'PROVIDER_HTTP_403']);
  assert.equal(fetch.mock.callCount(), 4);
});

test('an unclassified OpenRouter connection-test denial checks the same key once without retaining the response', async t => {
  const { sql, env } = fixture(t);
  const token = 'personal-openrouter-test-token';
  const privateText = 'upstream-private-key-details';
  const configured = await handleLlmConfig(configRequest('PUT', { provider: 'openrouter', model: 'meta-llama/llama-4-scout', token }), env);
  assert.equal(configured.status, 200);
  const generic = () => Response.json({ error: { code: 403, message: privateText } }, {
    status: 403, headers: { 'cf-ray': '0123456789abcdef-TEST' },
  });
  const html = () => new Response(`<html>${privateText}</html>`, { status: 403, headers: { 'Content-Type': 'text/html' } });
  const keyOk = () => Response.json({ data: { label: privateText } });
  const cases = [
    [generic, keyOk, 'OPENROUTER_403_CHAT_KEY_OK'],
    [html, keyOk, 'OPENROUTER_403_NON_API_KEY_OK'],
    [generic, () => new Response(privateText, { status: 401 }), 'OPENROUTER_403_KEY_UNAUTHORIZED'],
    [generic, () => html(), 'OPENROUTER_403_KEY_DENIED'],
    [generic, () => Response.json({ error: { metadata: { limit_source: 'openrouter_key_limit' } } }, { status: 403 }), 'OPENROUTER_403_KEY_LIMIT'],
    [generic, () => new Response(privateText, { status: 403, headers: { 'cf-mitigated': 'challenge' } }), 'OPENROUTER_403_CHALLENGE'],
    [generic, () => Response.json({ data: [] }), 'PROVIDER_HTTP_403'],
    [generic, () => Response.json({ data: { label: '0'.repeat(8192) } }), 'PROVIDER_HTTP_403'],
    [generic, () => Response.redirect('https://other.example.com/key', 307), 'PROVIDER_HTTP_403'],
    [html, () => { throw new DOMException(privateText, 'TimeoutError'); }, 'OPENROUTER_403_NON_API'],
  ];
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider call'); });
  for (const [reportReply, keyReply, expected] of cases) {
    fetch.mock.mockImplementationOnce(reportReply);
    fetch.mock.mockImplementationOnce(keyReply, fetch.mock.callCount() + 1);
    const id = crypto.randomUUID();
    const response = await handleReports(testRequest(id), env, {});
    const text = await response.text();
    const { report } = JSON.parse(text);
    assert.deepEqual([report.status, report.error_code, report.result_json], ['failed', expected, null]);
    assert.ok(!text.includes(privateText) && !text.includes(token));
    assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM reports WHERE id=?').get(id)).includes(privateText));
    const retry = await handleReports(testRequest(id), env, {});
    assert.equal((await retry.json()).report.error_code, expected);
  }
  assert.equal(fetch.mock.callCount(), 2 * cases.length);
  for (const [index, { arguments: [url, options] }] of fetch.mock.calls.entries()) {
    assert.equal(url, index % 2 === 0 ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://openrouter.ai/api/v1/key');
    assert.equal(options.method, index % 2 === 0 ? 'POST' : 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    if (index % 2) assert.ok(options.signal instanceof AbortSignal && !options.body);
  }
});

test('recognized OpenRouter denials and confirmed challenges skip the credential check', async t => {
  const { env } = fixture(t);
  let cancelled = false;
  const challenge = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    status: 403, headers: { 'cf-mitigated': 'challenge', 'Content-Type': 'text/html' },
  });
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider call'); });
  fetch.mock.mockImplementationOnce(() => challenge);
  const challenged = await handleReports(testRequest(), env, {});
  assert.equal((await challenged.json()).report.error_code, 'OPENROUTER_403_CHALLENGE');
  assert.equal(cancelled, true);

  fetch.mock.mockImplementationOnce(() => Response.json({ error: { metadata: { error_type: 'permission_denied' } } }, { status: 403 }));
  const denied = await handleReports(testRequest(), env, {});
  assert.equal((await denied.json()).report.error_code, 'OPENROUTER_403_PERMISSION');
  assert.equal(fetch.mock.callCount(), 2);
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
    provider: 'custom', base_url: 'https://provider.example.com/v1', model: 'model-a', has_token: true,
    default_available: true, default_model: 'openrouter/free', free_available: true,
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
