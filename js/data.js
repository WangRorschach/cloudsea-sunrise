// 数据获取：Open-Meteo（多模式气压层预报、CAMS 气溶胶、地名检索）+ Mapterhorn 地形瓦片取高程（浏览器内解码，失败时退回 Open-Meteo DEM）
import { LEVELS, HORIZON_DIST } from './model.js';
import { destination } from './sun.js';

const API = 'https://api.open-meteo.com/v1';
const SURF = {
  T2: 'temperature_2m', RH2: 'relative_humidity_2m', cc: 'cloud_cover', cl: 'cloud_cover_low',
  cm: 'cloud_cover_mid', ch: 'cloud_cover_high', precip: 'precipitation', wind10: 'wind_speed_10m',
  gust: 'wind_gusts_10m', vis: 'visibility', frz: 'freezing_level_height',
};
const LV = { z: 'geopotential_height', T: 'temperature', RH: 'relative_humidity', cc: 'cloud_cover', ws: 'wind_speed' };

// 响应缓存：同一请求 30 分钟内复用（模式最快每小时更新），节省 Open-Meteo 每小时调用配额
const TTL = 30 * 60e3;
const mem = new Map();
const CACHE = typeof caches !== 'undefined' ? 'yh-api-v1' : null;
async function cacheGet(url) {
  const m = mem.get(url);
  if (m && Date.now() - m.t < TTL) return m.j;
  if (!CACHE) return null;
  try {
    const r = await (await caches.open(CACHE)).match(url);
    if (!r || Date.now() - Number(r.headers.get('x-t')) > TTL) return null;
    const j = await r.json();
    mem.set(url, { t: Number(r.headers.get('x-t')), j });
    return j;
  } catch { return null; }
}
async function cachePut(url, j) {
  const t = Date.now();
  mem.set(url, { t, j });
  if (!CACHE) return;
  try {
    await (await caches.open(CACHE)).put(url, new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json', 'x-t': String(t) } }));
  } catch { /* 存储满或不可用时忽略 */ }
}

async function getJSON(url, tries = 3) {
  const hit = await cacheGet(url);
  if (hit) return hit;
  let last;
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url);
      const j = await r.json().catch(() => null);
      if (r.ok && j && !j.error) { cachePut(url, j); return j; }
      last = new Error(j?.reason || `HTTP ${r.status}`);
      if (r.status === 400 || r.status === 429) break;
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 600 * (k + 1)));
  }
  throw last;
}

const f4 = (x) => Number(x).toFixed(4);

export function parseLocal(s) {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return Date.UTC(y, m - 1, dd, hh, mm);
}

// ---- Mapterhorn 地形瓦片取高程（512 px Terrarium WebP，中国区最大 z12 ≈ 20 m/像素）----
const DEM_TILE = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
const tiles = new Map();
const canDecode = typeof createImageBitmap !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
function tilePixels(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tiles.has(key)) {
    tiles.set(key, (async () => {
      const r = await fetch(DEM_TILE.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      if (!r.ok) throw new Error(`DEM ${r.status}`);
      const bmp = await createImageBitmap(await r.blob());
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(bmp, 0, 0);
      return { w: bmp.width, d: cx.getImageData(0, 0, bmp.width, bmp.height).data };
    })().catch((e) => { tiles.delete(key); throw e; }));
  }
  return tiles.get(key);
}
async function demSample(lat, lon, z) {
  const n = 2 ** z;
  const fx = ((lon + 180) / 360) * n;
  const fy = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const tx = Math.floor(fx);
  const ty = Math.floor(fy);
  const t = await tilePixels(z, tx, ty);
  const px = Math.min(t.w - 1.001, Math.max(0, (fx - tx) * t.w - 0.5));
  const py = Math.min(t.w - 1.001, Math.max(0, (fy - ty) * t.w - 0.5));
  const h = (i, j) => { const k = (j * t.w + i) * 4; return t.d[k] * 256 + t.d[k + 1] + t.d[k + 2] / 256 - 32768; };
  const i = Math.floor(px);
  const j = Math.floor(py);
  const a = px - i;
  const b = py - j;
  return (h(i, j) * (1 - a) + h(i + 1, j) * a) * (1 - b) + (h(i, j + 1) * (1 - a) + h(i + 1, j + 1) * a) * b;
}

// zooms：每个点的瓦片层级（近处高精度、远处低层级以少下载）
export async function fetchElevations(coords, zooms) {
  if (canDecode) {
    try {
      return await Promise.all(coords.map((c, i) => demSample(c[0], c[1], zooms?.[i] ?? 12)));
    } catch (e) {
      console.warn('地形瓦片取高程失败，改用 Open-Meteo DEM', e);
    }
  }
  return fetchElevationsAPI(coords);
}

async function fetchElevationsAPI(coords) {
  const out = [];
  for (let i = 0; i < coords.length; i += 100) {
    const chunk = coords.slice(i, i + 100);
    const j = await getJSON(`${API}/elevation?latitude=${chunk.map((c) => f4(c[0])).join(',')}&longitude=${chunk.map((c) => f4(c[1])).join(',')}`);
    out.push(...j.elevation);
  }
  return out;
}

// 观测点海拔与周边谷底（3 个半径 × 12 个方位的环形采样，取 15% 分位）
export async function fetchSiteTerrain(lat, lon) {
  const ring = [];
  for (const r of [2000, 5000, 9000]) for (let b = 0; b < 360; b += 30) ring.push(destination(lat, lon, b, r));
  const el = await fetchElevations([[lat, lon], ...ring], [12, ...ring.map(() => 11)]);
  const ringEl = el.slice(1).filter((x) => x != null).sort((a, b) => a - b);
  const q = ringEl[Math.floor(ringEl.length * 0.15)] ?? el[0];
  return { dem: el[0], valley: q, ringMin: ringEl[0], ringMax: ringEl[ringEl.length - 1] };
}

export function profileDistances() {
  const xs = [];
  for (let x = 1000; x <= 10000; x += 500) xs.push(x);
  for (let x = 12500; x <= 60000; x += 2500) xs.push(x);
  for (let x = 66000; x <= 300000; x += 12000) xs.push(x);
  return xs;
}

export async function fetchTerrainProfile(lat, lon, azimuth) {
  const xs = profileDistances();
  const pts = xs.map((x) => destination(lat, lon, azimuth, x));
  const el = await fetchElevations(pts, xs.map((x) => (x <= 10000 ? 12 : x <= 60000 ? 10 : 8)));
  return xs.map((x, i) => ({ x, z: el[i], lat: pts[i][0], lon: pts[i][1] }));
}

export async function fetchForecast(lat, lon, zObs, modelIds) {
  const vars = [...Object.values(SURF), ...LEVELS.flatMap((p) => Object.values(LV).map((v) => `${v}_${p}hPa`))];
  const url = `${API}/forecast?latitude=${f4(lat)}&longitude=${f4(lon)}&elevation=${Math.round(zObs)}`
    + `&hourly=${vars.join(',')}&models=${modelIds.join(',')}&timezone=auto&forecast_days=7&past_days=1&wind_speed_unit=ms`;
  const d = await getJSON(url);
  const H = d.hourly;
  const pick = (name, m) => H[`${name}_${m}`] ?? (modelIds.length === 1 ? H[name] : undefined);
  const models = modelIds.map((m) => {
    const surf = Object.fromEntries(Object.entries(SURF).map(([k, v]) => [k, pick(v, m)]));
    const levels = {};
    for (const p of LEVELS) levels[p] = Object.fromEntries(Object.entries(LV).map(([k, v]) => [k, pick(`${v}_${p}hPa`, m)]));
    const valid = (levels[850].T ?? []).filter((x) => x != null).length;
    return { id: m, surf, levels, available: valid > 24 };
  });
  return {
    offset: d.utc_offset_seconds,
    tz: d.timezone,
    gridElevation: d.elevation,
    localTimes: H.time,
    times: H.time.map((s) => parseLocal(s) - d.utc_offset_seconds * 1000),
    models,
  };
}

// 沿每天日出方位的远方云量（多模式）
export async function fetchHorizon(lat, lon, azimuths, modelIds) {
  // 一周内日出方位只变几度：方位差 < 2° 的日子共用一组采样点（280 km 处偏差 < 10 km，小于模式格距），大幅减少请求点数
  const groups = [];
  const dayGroup = azimuths.map((az) => {
    let g = groups.findIndex((x) => Math.abs(x - az) < 2);
    if (g < 0) { groups.push(az); g = groups.length - 1; }
    return g;
  });
  const req = [];
  groups.forEach((az, g) => HORIZON_DIST.forEach((x) => req.push({ g, x, ll: destination(lat, lon, Math.round(az), x) })));
  const pts = [];
  azimuths.forEach((_, day) => req.forEach((r, i) => { if (r.g === dayGroup[day]) pts.push({ day, x: r.x, ll: r.ll, i }); }));
  const url = `${API}/forecast?latitude=${req.map((p) => f4(p.ll[0])).join(',')}&longitude=${req.map((p) => f4(p.ll[1])).join(',')}`
    + `&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high&models=${modelIds.join(',')}&timezone=GMT&forecast_days=7&past_days=1`;
  const d = await getJSON(url);
  const arr = Array.isArray(d) ? d : [d];
  const times = arr[0].hourly.time.map(parseLocal);
  const points = pts.map((p) => {
    const H = arr[p.i].hourly;
    const pick = (n, m) => H[`${n}_${m}`] ?? (modelIds.length === 1 ? H[n] : undefined);
    const models = Object.fromEntries(modelIds.map((m) => [m, {
      cl: pick('cloud_cover_low', m), cm: pick('cloud_cover_mid', m), ch: pick('cloud_cover_high', m),
    }]));
    return { day: p.day, x: p.x, lat: p.ll[0], lon: p.ll[1], models };
  });
  return { times, points };
}

export async function fetchAirQuality(lat, lon) {
  const d = await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${f4(lat)}&longitude=${f4(lon)}`
    + '&hourly=aerosol_optical_depth,pm2_5,dust&timezone=GMT&forecast_days=6&past_days=1');
  return {
    times: d.hourly.time.map(parseLocal),
    aod: d.hourly.aerosol_optical_depth, pm25: d.hourly.pm2_5, dust: d.hourly.dust,
  };
}

export async function geocode(q) {
  const ll = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (ll) return [{ name: `${ll[1]}, ${ll[2]}`, lat: +ll[1], lon: +ll[2], admin: '坐标' }];
  const d = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=10&language=zh&format=json`);
  return (d.results ?? []).map((r) => ({
    name: r.name, lat: r.latitude, lon: r.longitude, elevation: r.elevation,
    admin: [r.admin1, r.admin2, r.country].filter(Boolean).join(' · '),
  }));
}
