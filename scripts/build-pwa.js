import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const source = new URL('../frontend/public/', import.meta.url);
const output = new URL('../frontend/dist/', import.meta.url);
const staticPaths = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const digest = parts => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex').slice(0, 16);
};

const [bundle, stylesheet, template, serviceWorker, staticFiles] = await Promise.all([
  build({
    entryPoints: [fileURLToPath(new URL('js/app.js', source))],
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    minify: true,
    write: false,
  }),
  readFile(new URL('styles.css', source)),
  readFile(new URL('index.html', source), 'utf8'),
  readFile(new URL('sw.js', source), 'utf8'),
  Promise.all(staticPaths.map(path => readFile(new URL(path, source)))),
]);

const app = bundle.outputFiles[0].contents;
const appPath = `/assets/app-${digest([app])}.js`;
const stylePath = `/assets/styles-${digest([stylesheet])}.css`;
const index = template.replace('/js/app.js', appPath).replace('/styles.css', stylePath);
const staticAssets = staticPaths.map((path, position) => [`/${path}`, staticFiles[position]]);
const assets = [['/', index], [appPath, app], [stylePath, stylesheet], ...staticAssets];
const version = digest([serviceWorker, ...assets.flat()]);
const worker = serviceWorker
  .replace('__BUILD_VERSION__', version)
  .replace('/* SHELL_ASSETS */ []', JSON.stringify(assets.map(([path]) => path)))
  .replace('__APP_PATH__', appPath);

await rm(output, { recursive: true, force: true });
await mkdir(new URL('assets/', output), { recursive: true });
await Promise.all([...assets, ['/sw.js', worker]].map(([path, contents]) => {
  const file = path === '/' ? 'index.html' : path.slice(1);
  return writeFile(new URL(file, output), contents);
}));
