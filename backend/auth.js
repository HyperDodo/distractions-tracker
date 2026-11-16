// Cloudflare Access protects the whole application; API requests additionally
// verify the signed assertion. Never treat the email claim alone as identity.
const jwksCache = new Map();
const CACHE_MS = 5 * 60 * 1000;

function error(status, code) {
  return Response.json({ error: { code } }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function decodePart(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid JWT');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function parsePart(value) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodePart(value)));
}

async function getKeys(issuer, refresh = false) {
  const cached = jwksCache.get(issuer);
  if (!refresh && cached && cached.expires > Date.now()) return cached.keys;
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('JWKS unavailable');
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error('Invalid JWKS');
  jwksCache.set(issuer, { keys: body.keys, expires: Date.now() + CACHE_MS });
  return body.keys;
}

/** Return null on success, otherwise an HTTP error response. */
export async function authenticate(request, env) {
  let issuer;
  try {
    const url = new URL(env.ACCESS_TEAM_DOMAIN);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(url.hostname) || url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error('Invalid issuer');
    issuer = url.origin;
    if (!env.ACCESS_AUD || !env.ACCESS_EMAIL) throw new Error('Missing configuration');
  } catch {
    return error(503, 'AUTH_CONFIGURATION_ERROR');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return error(401, 'AUTH_REQUIRED');
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    const header = parsePart(parts[0]);
    const claims = parsePart(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.crit !== undefined) throw new Error('Invalid header');
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audiences.includes(env.ACCESS_AUD) || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now))) throw new Error('Invalid claims');
    let keys = await getKeys(issuer);
    let jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    if (!jwk) {
      keys = await getKeys(issuer, true);
      jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    }
    if (!jwk) throw new Error('Unknown key');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodePart(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) throw new Error('Invalid signature');
    if (typeof claims.email !== 'string' || claims.email.toLowerCase() !== env.ACCESS_EMAIL.trim().toLowerCase()) return error(403, 'ACCESS_DENIED');
    return null;
  } catch {
    return error(401, 'AUTH_REQUIRED');
  }
}

/** Apply to every state-changing API request; no cross-origin mutations. */
export function checkMutation(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null;
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) return error(403, 'ACCESS_DENIED');
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return error(415, 'JSON_REQUIRED');
  return null;
}
