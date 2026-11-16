import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { authenticate, checkMutation } from '../backend/auth.js';

globalThis.crypto ||= webcrypto;
const issuer = 'https://example.cloudflareaccess.com';
const env = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: 'aud', ACCESS_EMAIL: 'owner@example.com' };
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
jwk.kid = 'test-key'; jwk.alg = 'RS256'; jwk.use = 'sig';
const nativeFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
  return Response.json({ keys: [jwk] });
};
const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
async function token(claims = {}, header = {}) {
  const data = `${encode({ alg: 'RS256', kid: 'test-key', ...header })}.${encode({ iss: issuer, aud: ['aud'], exp: Math.floor(Date.now() / 1000) + 60, email: 'owner@example.com', ...claims })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(signature).toString('base64url')}`;
}
const request = jwt => new Request('https://app.example/api/entries', { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} });

test('signed owner assertion succeeds; forged or invalid claims fail', async () => {
  assert.equal(await authenticate(request(await token()), env), null);
  assert.equal((await authenticate(request(), env)).status, 401);
  assert.equal((await authenticate(request(await token({ aud: ['other'] })), env)).status, 401);
  assert.equal((await authenticate(request(await token({ exp: 1 })), env)).status, 401);
  assert.equal((await authenticate(request(await token({ email: 'other@example.com' })), env)).status, 403);
  assert.equal((await authenticate(request((await token()).replace(/.$/, '!')), env)).status, 401);
  assert.equal((await authenticate(request(await token()), { ...env, ACCESS_AUD: '' })).status, 503);
});
test('mutations require same origin and JSON', () => {
  const make = headers => new Request('https://app.example/api/entries', { method: 'POST', headers });
  assert.equal(checkMutation(make({ Origin: 'https://app.example', 'Content-Type': 'application/json; charset=utf-8' })), null);
  assert.equal(checkMutation(make({ Origin: 'https://evil.example', 'Content-Type': 'application/json' })).status, 403);
  assert.equal(checkMutation(make({ Origin: 'https://app.example', 'Content-Type': 'text/plain' })).status, 415);
});
process.on('exit', () => { globalThis.fetch = nativeFetch; });
