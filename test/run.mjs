// 用法：node test/run.mjs
import assert from 'node:assert/strict';
import { solarPosition, findRise, horizonDip, rayHeight, destination } from '../js/sun.js';
import { analyzeCloudSea, analyzeSunrise, dewpoint, potentialTemp, MODELS, runForecast } from '../js/model.js';
import { fetchSiteTerrain, fetchForecast, fetchHorizon, fetchAirQuality, fetchTerrainProfile } from '../js/data.js';

// 1. 天文：2026-06-21 北京（39.9042,116.4074）海平面日出约 04:45 CST、方位约 59°
{
  const mid = Date.UTC(2026, 5, 21) - 8 * 3600e3;
  const r = findRise(mid, mid + 12 * 3600e3, 39.9042, 116.4074, -0.833);
  const local = new Date(r.time + 8 * 3600e3);
  const min = local.getUTCHours() * 60 + local.getUTCMinutes();
  assert.ok(Math.abs(min - (4 * 60 + 45)) <= 3, `北京夏至日出 ${local.toISOString()}`);
  assert.ok(Math.abs(r.azimuth - 59) < 2, `方位 ${r.azimuth}`);
  // 正午太阳高度 ≈ 90 - 39.9 + 23.44 = 73.5°
  const noon = solarPosition(Date.UTC(2026, 5, 21, 4, 14), 39.9042, 116.4074).elevation;
  assert.ok(Math.abs(noon - 73.5) < 0.5, `正午高度 ${noon}`);
}
// 2. 几何：1800 m 眼高差约 1.29°，光线切点约 162 km
{
  const dip = horizonDip(1800);
  assert.ok(Math.abs(dip - 1.29) < 0.05, `dip ${dip}`);
  assert.ok(Math.abs(rayHeight(162000, 1800, -dip)) < 30);
  const [la, lo] = destination(30, 118, 90, 111195);
  assert.ok(Math.abs(la - 29.99) < 0.05 && Math.abs(lo - 119.155) < 0.02);
}
// 3. 热力学
assert.ok(Math.abs(dewpoint(20, 50) - 9.3) < 0.2);
assert.ok(Math.abs(potentialTemp(0, 850) - 286.2) < 0.3);

// 4. 理想廓线：900 m 处饱和层，云顶上方强逆温，观测点 1800 m → 应高概率
{
  const prof = [
    { z: 300, T: 8, RH: 98, ws: 2 }, { z: 600, T: 6.5, RH: 99, ws: 2 }, { z: 900, T: 5, RH: 97, ws: 3 },
    { z: 1150, T: 9, RH: 45, ws: 3 }, { z: 1500, T: 9.5, RH: 35, ws: 4 }, { z: 2000, T: 7, RH: 30, ws: 5 },
  ].map((l, k) => {
    const p = 1000 - k * 40;
    return { ...l, p, cc: null, th: potentialTemp(l.T, p), Td: dewpoint(l.T, l.RH) };
  });
  const r = analyzeCloudSea(prof, { zObs: 1800, zValley: 300, cm: 5, ch: 10, precip: 0, rain24: 0, sunElev: -3 });
  assert.equal(r.type, 'A');
  assert.ok(r.ztop > 900 && r.ztop < 1150, `ztop ${r.ztop}`);
  assert.ok(r.P > 60, `P ${r.P}`);
  // 同一廓线，观测点降到 950 m（处于云中）→ 低概率
  const r2 = analyzeCloudSea(prof, { zObs: 950, zValley: 300, cm: 5, ch: 10, precip: 0, rain24: 0, sunElev: -3 });
  assert.ok(r2.P < 25, `in-cloud P ${r2.P}`);
  // 日出：远方无云 → 高可见度
  const s = analyzeSunrise({ zObs: 1800, alphaDeg: -1.3, sea: r, cm: 40, ch: 30, precip: 0, aod: 0.2,
    samples: [10, 30, 70, 130, 200, 280].map((k) => ({ x: k * 1000, cl: 0, cm: 0, ch: 0 })) });
  assert.ok(s.Pvis > 90 && s.glow > 60, JSON.stringify({ v: s.Pvis, g: s.glow }));
  const s2 = analyzeSunrise({ zObs: 1800, alphaDeg: -1.3, sea: r, cm: 40, ch: 30, precip: 0, aod: 0.2,
    samples: [10, 30, 70, 130, 200, 280].map((k) => ({ x: k * 1000, cl: 100, cm: 100, ch: 0 })) });
  assert.ok(s2.Pvis < 15, `blocked ${s2.Pvis}`);
}
console.log('✓ 单元测试通过');

// 5. 真实数据端到端：黄山光明顶
const site = { lat: 30.1306, lon: 118.1636, zObs: 1860 };
const t0 = Date.now();
const ter = await fetchSiteTerrain(site.lat, site.lon);
site.zValley = ter.valley;
const ids = MODELS.map((m) => m.id);
const [fc, aq] = await Promise.all([fetchForecast(site.lat, site.lon, site.zObs, ids), fetchAirQuality(site.lat, site.lon).catch(() => null)]);
const pre = runForecast({ fc, site, horizon: null, aq, terrain: null });
const az = pre.days.map((d) => d.geo.sea.azimuth);
const [horizon, terrain] = await Promise.all([fetchHorizon(site.lat, site.lon, az, ids), fetchTerrainProfile(site.lat, site.lon, az[1] ?? az[0])]);
const res = runForecast({ fc, site, horizon, aq, terrain });
console.log(`数据 ${(Date.now() - t0) / 1000}s，谷底 ${ter.valley} m，DEM ${ter.dem} m，可用模式`, res.models.join(','));
for (const d of res.days) {
  const tl = new Date(d.rise.time + fc.offset * 1000).toISOString().slice(11, 16);
  console.log(d.key, tl, `方位${d.rise.azimuth.toFixed(0)}° 地平${d.geo.alpha.toFixed(2)}°`,
    `云海 ${d.sea.mean?.toFixed(0)}% [${d.sea.min?.toFixed(0)}-${d.sea.max?.toFixed(0)}]`,
    `日出 ${d.vis.mean?.toFixed(0)}% 朝霞 ${d.glow.mean?.toFixed(0)} 云顶 ${d.ztop.mean?.toFixed(0)} 类型 ${d.type} AOD ${d.air.aod}`);
}
