const cachePrefix = 'interruption-shell-';
const cacheName = `${cachePrefix}__BUILD_VERSION__`;
const shellAssets = /* SHELL_ASSETS */ [];
const appPath = '__APP_PATH__';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const files = await Promise.all(shellAssets.map(async path => {
      const response = await fetch(path, { cache: 'reload', redirect: 'error' });
      if (!response.ok || response.redirected) throw new Error(`Unavailable PWA asset: ${path}`);
      if (path === '/' && !(await response.clone().text()).includes(`src="${appPath}"`)) {
        throw new Error('The PWA start page is unavailable');
      }
      return [path, response];
    }));
    const cache = await caches.open(cacheName);
    await Promise.all(files.map(([path, response]) => cache.put(path, response)));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== cacheName)
      .map(name => caches.delete(name)));
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  const isStartPage = request.mode === 'navigate' && url.pathname === '/';
  const isShellAsset = url.search === '' && url.pathname !== '/' && shellAssets.includes(url.pathname);
  if (!isStartPage && !isShellAsset) return;

  event.respondWith(fetch(request).catch(async () => {
    const cache = await caches.open(cacheName);
    return (await cache.match(url.pathname)) || Response.error();
  }));
});
