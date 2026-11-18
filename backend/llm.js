const PRESETS = new Map([
  ['openrouter', 'https://openrouter.ai/api/v1'],
  ['cheapai', 'https://cheapai.io/v1'],
]);
const FREE_CONNECTION = {
  provider: 'openrouter', base_url: PRESETS.get('openrouter'), model: 'openrouter/free',
};
const PUBLIC_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const LOCAL_HOST = /\.(?:localhost|localdomain|local|internal|lan|corp|home|test|invalid|example|onion|alt|home\.arpa)$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const error = (code, message, status = 400) => json({ error: { code, message } }, status);

function customBaseUrl(value, requestUrl) {
  if (typeof value !== 'string' || value.length > 2000 || !/^https:\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.hostname === new URL(requestUrl).hostname) return null;
    if (url.hostname.length > 253 || !PUBLIC_HOST.test(url.hostname) || LOCAL_HOST.test(url.hostname)) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function baseUrl(provider, value, requestUrl) {
  return provider === 'custom' ? customBaseUrl(value, requestUrl) : PRESETS.get(provider);
}

function tokenValue(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return /^[!-~]{1,2048}$/.test(token) ? token : null;
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function toBase64(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}

async function encryptionKey(env) {
  const raw = fromBase64(env.LLM_TOKEN_ENCRYPTION_KEY || '');
  if (raw.byteLength !== 32) throw new Error('Invalid LLM encryption key');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function encryptionParams(iv, provider, url) {
  return { name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify([provider, url])) };
}

async function encryptToken(env, provider, url, token) {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(encryptionParams(iv, provider, url), key, encoder.encode(token));
  return `v1.${toBase64(iv)}.${toBase64(encrypted)}`;
}

async function decryptToken(env, config) {
  const [version, iv, ciphertext] = config.encrypted_token.split('.');
  if (version !== 'v1') throw new Error('Invalid LLM token format');
  const key = await encryptionKey(env);
  const params = encryptionParams(fromBase64(iv), config.provider, config.base_url);
  return decoder.decode(await crypto.subtle.decrypt(params, key, fromBase64(ciphertext)));
}

async function loadConfig(env) {
  return env.DB.prepare('SELECT provider, base_url, model, encrypted_token FROM llm_config WHERE id=1').first();
}

function publicConfig(config, env) {
  return {
    provider: config?.provider ?? null,
    base_url: config?.base_url ?? null,
    model: config?.model ?? null,
    has_token: Boolean(config?.encrypted_token),
    free_available: Boolean(tokenValue(env.OPENROUTER_FREE_API_KEY)),
  };
}

export async function resolveLlm(env, requestUrl) {
  const config = await loadConfig(env);
  if (!config) {
    const token = tokenValue(env.OPENROUTER_FREE_API_KEY);
    return token ? { ...FREE_CONNECTION, token } : {
      error: 'LLM_NOT_CONFIGURED', message: 'Бесплатный OpenRouter не настроен. Укажите своё подключение в настройках.',
    };
  }

  if (baseUrl(config.provider, config.base_url, requestUrl) !== config.base_url) {
    return { error: 'INVALID_LLM_URL', message: 'Укажите корректный HTTPS-адрес поставщика в настройках.' };
  }
  try {
    const token = tokenValue(await decryptToken(env, config));
    if (!token) throw new Error('Invalid LLM token');
    return { provider: config.provider, base_url: config.base_url, model: config.model, token };
  } catch {
    return { error: 'LLM_TOKEN_UNAVAILABLE', message: 'Не удалось прочитать сохранённый токен. Введите его заново в настройках.' };
  }
}

async function clearConfig(env) {
  await env.DB.prepare('DELETE FROM llm_config WHERE id=1').run();
  return json(publicConfig(null, env));
}

export async function handleLlmConfig(request, env) {
  if (new URL(request.url).pathname !== '/api/llm/config') return null;
  if (request.method === 'GET') return json(publicConfig(await loadConfig(env), env));
  if (request.method === 'DELETE') return clearConfig(env);
  if (request.method !== 'PUT') return null;

  const invalidConfig = () => error('INVALID_LLM_CONFIG', 'Выберите поставщика и укажите модель.');
  let body;
  try { body = await request.json(); } catch { return invalidConfig(); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidConfig();
  if (body.provider === null) return clearConfig(env);
  if (body.provider !== 'custom' && !PRESETS.has(body.provider)) return invalidConfig();
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model || model.length > 256 || /[\s\p{Cc}]/u.test(model)) return invalidConfig();
  const url = baseUrl(body.provider, body.base_url, request.url);
  if (!url) return error('INVALID_LLM_URL', 'Укажите публичный HTTPS-адрес API без логина, параметров и фрагмента.');

  if (body.token === undefined || (typeof body.token === 'string' && !body.token.trim())) {
    const result = await env.DB.prepare('UPDATE llm_config SET model=? WHERE id=1 AND provider=? AND base_url=?')
      .bind(model, body.provider, url).run();
    if (!result.meta.changes) return error('LLM_TOKEN_REQUIRED', 'Введите токен выбранного поставщика.');
  } else {
    const token = tokenValue(body.token);
    if (!token) return error('INVALID_LLM_TOKEN', 'Введите токен без пробелов и переносов строки.');
    let encrypted;
    try { encrypted = await encryptToken(env, body.provider, url, token); }
    catch { return error('LLM_TOKEN_STORAGE_UNAVAILABLE', 'На сервере не настроено хранение токенов.', 503); }
    await env.DB.prepare(`INSERT INTO llm_config(id,provider,base_url,model,encrypted_token) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,base_url=excluded.base_url,model=excluded.model,encrypted_token=excluded.encrypted_token`)
      .bind(body.provider, url, model, encrypted).run();
  }
  return json(publicConfig(await loadConfig(env), env));
}
