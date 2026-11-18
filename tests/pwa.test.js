import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const origin = 'https://tracker.test';
const dist = new URL('../frontend/dist/', import.meta.url);
const index = await readFile(new URL('index.html', dist), 'utf8');
const sw = await readFile(new URL('sw.js', dist), 'utf8');
const appPath = index.match(/src="(\/assets\/app-[a-f0-9]+\.js)"/)[1];
const cssPath = index.match(/href="(\/assets\/styles-[a-f0-9]+\.css)"/)[1];

test('the PWA manifest and packaged assets agree', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', dist), 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(index, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
  assert.doesNotMatch(sw, /__BUILD_VERSION__|__APP_PATH__/);
  for (const [path, size] of [...manifest.icons.map(icon => [icon.src, Number.parseInt(icon.sizes, 10)]), ['/apple-touch-icon.png', 180]]) {
    const image = await readFile(new URL(path.slice(1), dist));
    assert.equal(image.readUInt32BE(16), size);
    assert.equal(image.readUInt32BE(20), size);
  }
  for (const path of [appPath, cssPath]) {
    assert.ok((await readFile(new URL(path.slice(1), dist))).length > 0);
  }
});

function worker() {
  const listeners = new Map();
  const stores = new Map([['interruption-shell-previous', new Map()], ['unrelated', new Map()]]);
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return { put: (key, value) => entries.set(key, value), match: key => entries.get(key)?.clone() };
    },
    keys: () => [...stores.keys()],
    delete: name => stores.delete(name),
  };
  const scope = {
    URL,
    Response,
    caches,
    self: { location: { origin }, addEventListener: (name, listener) => listeners.set(name, listener) },
    async fetch(path) { return new Response(path === '/' ? index : 'asset'); },
  };
  vm.runInNewContext(sw, scope);

  return {
    stores,
    fetch: next => { scope.fetch = next; },
    run(name) { return new Promise((resolve, reject) => listeners.get(name)({ waitUntil: tasks => tasks.then(resolve, reject) })); },
    request(path, method = 'GET', mode = 'navigate') {
      let response;
      const url = new URL(path, origin).href;
      listeners.get('fetch')({ request: { url, method, mode }, respondWith: value => { response = value; } });
      return response;
    },
  };
}

test('offline uses the static shell only and online auth responses pass through', async () => {
  const app = worker();
  await app.run('install');
  await app.run('activate');
  assert.equal(app.stores.has('interruption-shell-previous'), false);
  assert.equal(app.stores.has('unrelated'), true);
  const shell = [...app.stores].find(([key]) => key.startsWith('interruption-shell-'))[1];
  assert.deepEqual([...shell.keys()].sort(), [
    '/', appPath, cssPath, '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest',
  ].sort());

  const authRedirect = Response.redirect('https://auth.test/login');
  app.fetch(async () => authRedirect);
  assert.equal(await app.request('/'), authRedirect);

  app.fetch(async () => { throw new TypeError('Offline'); });
  assert.equal(await (await app.request('/')).text(), index);
  assert.equal(await (await app.request(appPath, 'GET', 'same-origin')).text(), 'asset');
  assert.equal(app.request('/api/snapshot'), undefined);
  assert.equal(app.request('/api/export?format=json'), undefined);
  assert.equal(app.request('/cdn-cgi/access/login'), undefined);
  assert.equal(app.request('https://other.test/'), undefined);
  assert.equal(app.request('/', 'POST'), undefined);
});

test('install rejects an Access page returned for the start URL', async () => {
  const app = worker();
  app.fetch(async (path, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(path === '/' ? '<html>Cloudflare Access</html>' : 'asset');
  });
  await assert.rejects(app.run('install'), /start page is unavailable/);
  assert.equal(app.stores.size, 2);
});
