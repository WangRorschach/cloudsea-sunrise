// 打包成一个可直接分享的 HTML：JS/CSS/第三方库/地点包/方法文档全部内嵌，
// 只有地图瓦片、气象数据等在线数据仍需联网。
// 用法：node tools/build-single.mjs   → dist/cloudsea-sunrise.html
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'tools', '.vendor');
const read = (p) => readFileSync(join(root, p), 'utf8');

const VENDOR = {
  'maplibre-gl.js': 'maplibre-gl@5.17.0/dist/maplibre-gl.js',
  'maplibre-gl.css': 'maplibre-gl@5.17.0/dist/maplibre-gl.css',
  'contour.js': 'maplibre-contour@0.1.1/dist/index.min.js',
  'chart.js': 'chart.js@4.4.6/dist/chart.umd.js',
};
mkdirSync(vendorDir, { recursive: true });
const vendor = {};
for (const [name, path] of Object.entries(VENDOR)) {
  const f = join(vendorDir, name);
  if (!existsSync(f)) {
    const r = await fetch(`https://unpkg.com/${path}`);
    if (!r.ok) throw new Error(`下载 ${path} 失败：HTTP ${r.status}`);
    writeFileSync(f, await r.text());
  }
  vendor[name] = readFileSync(f, 'utf8');
}

// 应用代码打包为单个 ES 模块
const bundle = execFileSync('npx', ['-y', 'esbuild@0.24.0', join(root, 'js/app.js'), '--bundle', '--format=esm', '--minify', '--target=es2020', '--legal-comments=none'], { encoding: 'utf8', maxBuffer: 64 << 20 });

// 内嵌到 <script> / <style> 时防止提前闭合
const js = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const css = read('css/style.css');

const docs = read('docs.html').replace(/<link rel="stylesheet" href="css\/style.css"\s*\/?>/, () => `<style>${css}</style>`);
const pois = JSON.parse(read('data/pois.json'));

let html = read('index.html');
const swap = (re, out) => {
  if (!re.test(html)) throw new Error(`index.html 中找不到 ${re}`);
  html = html.replace(re, () => out);
};
swap(/<link rel="stylesheet" href="https:\/\/unpkg\.com\/maplibre-gl[^>]*>/, `<style>${vendor['maplibre-gl.css']}</style>`);
swap(/<link rel="stylesheet" href="css\/style\.css"\s*\/?>/, `<style>${css}</style>`);
swap(/<script src="https:\/\/unpkg\.com\/maplibre-gl[^>]*><\/script>/, `<script>${js(vendor['maplibre-gl.js'])}</script>`);
swap(/<script src="https:\/\/unpkg\.com\/maplibre-contour[^>]*><\/script>/, `<script>${js(vendor['contour.js'])}</script>`);
swap(/<script src="https:\/\/unpkg\.com\/chart\.js[^>]*><\/script>/, `<script>${js(vendor['chart.js'])}</script>`);
swap(/<script type="module" src="js\/app\.js"><\/script>/,
  `<script>window.__POIS__=${json(pois)};window.__DOCS__=${json(docs)};</script>\n<script type="module">${js(bundle)}</script>`);
swap(/<a class="brand" href="\.\/">/, '<a class="brand" href="javascript:scrollTo(0,0)">');

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'cloudsea-sunrise.html');
writeFileSync(out, html);
console.log(`${out}  ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB`);
