// 云海 / 日出诊断模型。纯函数，不依赖浏览器，可在 Node 中单测。
import {
  solarPosition, horizonDip, sunriseGeometricTarget, findRise, rayHeight, terrainAngle,
} from './sun.js';

export const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 600, 500];

export const MODELS = [
  { id: 'ecmwf_ifs025', name: 'ECMWF IFS', org: '欧洲中期天气预报中心', res: '0.25°' },
  { id: 'gfs_seamless', name: 'NCEP GFS', org: '美国国家环境预报中心', res: '0.11–0.25°' },
  { id: 'icon_seamless', name: 'DWD ICON', org: '德国气象局', res: '0.0625–0.125°' },
  { id: 'cma_grapes_global', name: 'CMA GRAPES', org: '中国气象局', res: '0.125°' },
  { id: 'jma_seamless', name: 'JMA GSM', org: '日本气象厅', res: '0.25–0.5°' },
];

// 日出光路采样距离（米）
export const HORIZON_DIST = [10000, 30000, 70000, 130000, 200000, 280000];

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export function piecewise(x, pts) {
  if (x == null || Number.isNaN(x)) return null;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

// Magnus 公式（Alduchov & Eskridge 1996 系数）
export function dewpoint(T, RH) {
  const a = 17.625;
  const b = 243.04;
  const g = Math.log(Math.max(RH, 1) / 100) + (a * T) / (b + T);
  return (b * g) / (a - g);
}

export function potentialTemp(Tc, p) {
  return (Tc + 273.15) * Math.pow(1000 / p, 0.2857);
}

// JAG/TI 风寒指数（加拿大/美国气象部门标准），v 为 m/s
export function windChill(T, v) {
  const k = v * 3.6;
  if (T > 10 || k < 4.8) return T;
  return 13.12 + 0.6215 * T - 11.37 * k ** 0.16 + 0.3965 * T * k ** 0.16;
}

export function interpAt(prof, z, key) {
  const v = prof.filter((l) => l[key] != null);
  if (!v.length) return null;
  if (z <= v[0].z) return v[0][key];
  for (let k = 1; k < v.length; k++) {
    if (z <= v[k].z) {
      const a = v[k - 1];
      const b = v[k];
      return a[key] + ((b[key] - a[key]) * (z - a.z)) / (b.z - a.z);
    }
  }
  return v[v.length - 1][key];
}

// 由气压层数据构造某时刻的垂直廓线（按高度升序），剔除低于谷底的外推层
export function buildProfile(md, i, zFloor) {
  const out = [];
  for (const p of LEVELS) {
    const L = md.levels[p];
    if (!L) continue;
    const z = L.z?.[i];
    const T = L.T?.[i];
    const RH = L.RH?.[i];
    if (z == null || T == null || RH == null) continue;
    if (z < zFloor - 50) continue;
    out.push({
      p, z, T, RH,
      cc: L.cc?.[i] ?? null,
      ws: L.ws?.[i] ?? null,
      th: potentialTemp(T, p),
      Td: dewpoint(T, RH),
    });
  }
  out.sort((a, b) => a.z - b.z);
  return out;
}

export function layersOf(prof) {
  const lay = [];
  for (let k = 0; k < prof.length - 1; k++) {
    const a = prof[k];
    const b = prof[k + 1];
    const dz = b.z - a.z;
    if (dz <= 0) continue;
    lay.push({
      k, z0: a.z, z1: b.z, zmid: (a.z + b.z) / 2,
      dth: ((b.th - a.th) / dz) * 1000, // 位温梯度 K/km
      dT: b.T - a.T,
      dRH: a.RH - b.RH,
    });
  }
  return lay;
}

/**
 * 云海诊断
 * c: { zObs, zValley, cm, ch, precip, rain24, sunElev, wind10 }
 */
export function analyzeCloudSea(prof, c) {
  const r = {
    P: null, ztop: null, zbase: null, ztopRange: null, topEstimated: false, type: 'none', margin: null,
    lowCloud: c.cl ?? null, surfaceRH: c.rh2 ?? null,
    cap: null, invDT: null, jump: null, rhObs: null, wsObs: null, f: {}, notes: [],
  };
  r.validPressureLayers = prof.length;
  if (prof.length < 2) { r.diagnosis = 'insufficient-profile'; r.diagnosisDetails = '有效气压层少于两层，无法建立低层垂直廓线'; return r; }
  const lay = layersOf(prof);

  // A 型：层积云 / 低层云顶（饱和层）
  const sat = (l) => l.RH >= 92 || (l.cc != null && l.cc >= 70);
  let kb = -1;
  let kt = -1;
  for (let k = 0; k < prof.length; k++) {
    if (prof[k].z > c.zObs + 1000) break;
    if (sat(prof[k])) {
      if (kb < 0) kb = k;
      kt = k;
    } else if (kb >= 0) break;
  }
  let satF = 0;
  let satTop = null;
  let satBase = null;
  if (kb >= 0) {
    const run = prof.slice(kb, kt + 1);
    const maxRH = Math.max(...run.map((l) => l.RH));
    const maxCC = Math.max(...run.map((l) => l.cc ?? 0));
    satBase = kb === 0 ? Math.min(prof[0].z, c.zValley) : (prof[kb - 1].z + prof[kb].z) / 2;
    const a = prof[kt];
    const b = prof[kt + 1];
    if (b && a.RH > 90 && b.RH < 90) {
      satTop = a.z + ((b.z - a.z) * (a.RH - 90)) / (a.RH - b.RH);
      r.ztopRange = [a.z, b.z];
    } else {
      // Upper cloud boundary is not resolved: never fabricate a precise top.
      satTop = null;
      r.topEstimated = true;
      r.ztopRange = b ? [a.z, b.z] : [a.z, null];
    }
    satF = Math.max(clamp((maxRH - 88) / 8), maxCC / 100) * (satTop == null ? 0.5 : piecewise(satTop - satBase, [[0, 0.4], [150, 0.7], [400, 1]]));
  }

  // B 型：辐射雾 / 谷雾（夜间晴空、弱风、近饱和、低层稳定）
  const low = prof[0];
  const clearSky = c.cm == null || c.ch == null ? null : 1 - (0.8 * Math.max(c.cm, c.ch)) / 100;
  const dd = low.T - low.Td;
  const wsLow = low.ws ?? c.wind10 ?? null;
  const stableLow = lay.length ? piecewise(lay[0].dth, [[0, 0.2], [4, 0.6], [8, 1]]) : 0.3;
  const night = piecewise(c.sunElev, [[-5, 1], [5, 0.9], [15, 0.4], [30, 0.05]]);
  let fogP = wsLow == null || clearSky == null ? null : piecewise(dd, [[0, 1], [1.5, 0.8], [3, 0.45], [5, 0.1], [7, 0]])
    * piecewise(wsLow, [[2, 1], [5, 0.6], [9, 0.15]]) * clearSky * stableLow * night;
  const afterRain = c.rain24 != null && c.precip != null && c.rain24 >= 2 && c.precip < 0.1;
  if (afterRain && fogP != null) fogP = Math.min(1, fogP * 1.25 + 0.05);
  let fogTop = null;
  if (fogP != null && fogP > 0.05) {
    let top = low.z;
    for (const l of lay) {
      if (l.dth >= 6) top = l.z1;
      else break;
    }
    // An upper pressure level is not a valley-surface observation. Resolve a
    // fog top only when the lowest valid level is genuinely near valley floor.
    fogTop = low.z <= c.zValley + 200 && top > low.z ? top : null;
  }

  let Fcloud;
  if (satTop != null && satF >= (fogP ?? 0)) {
    Fcloud = satF; r.ztop = satTop; r.zbase = satBase; r.type = 'A';
  } else if (fogTop != null && fogP != null && fogP > 0.08) {
    Fcloud = fogP; r.ztop = fogTop; r.zbase = c.zValley; r.type = 'B';
    r.topEstimated = true;
    r.ztopRange = [low.z, fogTop];
  } else {
    Fcloud = Math.max(satF, fogP ?? 0); r.ztop = satTop ?? fogTop; r.zbase = satBase;
  }
  if (afterRain && r.type !== 'none') r.notes.push('afterRain');
  if (r.ztop != null) Fcloud *= piecewise(r.ztop - c.zValley, [[0, 0], [80, 0.4], [250, 1]]);

  // 云顶相对观测点高度裕度
  r.margin = r.ztop != null ? c.zObs - r.ztop : null;
  const Fheight = r.margin == null ? 0
    : piecewise(r.margin, [[-200, 0], [0, 0.2], [80, 0.65], [200, 1], [1200, 1], [2500, 0.55], [4000, 0.35]]);

  // 封盖层：云顶附近位温梯度 + 湿度跃变
  const ref = r.ztop ?? c.zValley + 300;
  let near = lay.filter((l) => l.zmid >= ref - 250 && l.zmid <= ref + 600);
  if (!near.length) near = lay.filter((l) => l.z1 >= ref).slice(0, 1);
  if (!near.length) near = lay.slice(-1);
  r.cap = Math.max(...near.map((l) => l.dth));
  r.invDT = Math.max(...near.map((l) => l.dT));
  r.jump = Math.max(...near.map((l) => l.dRH));
  const Fcap = 0.7 * piecewise(r.cap, [[0, 0.1], [3, 0.4], [6, 0.75], [10, 1]])
    + 0.3 * piecewise(r.jump, [[0, 0.2], [20, 0.6], [40, 1]]);

  // 观测点上方通透度
  r.rhObs = interpAt(prof, c.zObs, 'RH');
  const Fdry = r.rhObs == null || c.cm == null || c.ch == null ? null
    : piecewise(r.rhObs, [[60, 1], [80, 0.85], [90, 0.5], [97, 0.1]])
    * (1 - (0.55 * c.cm) / 100) * (1 - (0.2 * c.ch) / 100);

  r.wsObs = interpAt(prof, c.zObs, 'ws') ?? c.wind10;
  const Fwind = r.wsObs == null ? null : piecewise(r.wsObs, [[4, 1], [8, 0.75], [12, 0.45], [18, 0.15]]);
  const Fprecip = c.precip == null ? null : piecewise(c.precip, [[0, 1], [0.1, 0.85], [0.5, 0.45], [2, 0.15]]);

  const lg = (x) => Math.log(Math.max(x, 0.02));
  const Q = [Fcap, Fdry, Fwind, Fprecip].some((v) => v == null) ? null
    : Math.exp(0.35 * lg(Fcap) + 0.3 * lg(Fdry) + 0.15 * lg(Fwind) + 0.2 * lg(Fprecip));
  r.f = { cloud: Fcloud, height: Fheight, cap: Fcap, dry: Fdry, wind: Fwind, precip: Fprecip, Q };
  // P is an UNCALIBRATED suitability score (0..100), never a verified probability.
  // Distinguish a genuinely unfavorable (no diagnosed cloud) hour from missing
  // data or a cloud layer whose upper boundary cannot be resolved.
  // No saturated levels + negligible valley-fog signal -> score 0, not missing.
  // Do not equate a dry *pressure-level* column with absence of shallow cloud.
  // Open-Meteo supplies low cloud cover separately; previously we requested it
  // but never passed it into this diagnosis, creating artificial zeros.
  // 5% is a conservative screening threshold, NOT an event probability.
  const shallowCloudSignal = c.cl != null && c.cl > 5;
  const nearSurfaceSaturation = c.rh2 != null && c.rh2 >= 95;
  const noCloudEvidence = kb < 0 && fogP != null && fogP <= 0.08
    && c.cl != null && c.cl <= 5 && !nearSurfaceSaturation;
  const missingFields = [
    ['cm', c.cm], ['ch', c.ch], ['precip', c.precip], ['obsRH', r.rhObs], ['obsWind', r.wsObs],
    // Low-cloud cover is required only before concluding *absence* of shallow cloud.
    ...(kb < 0 ? [['lowCloud', c.cl]] : []),
  ].filter(([, v]) => v == null).map(([k]) => k);
  // A dry upper profile cannot exclude shallow fog in an unsampled valley.
  const lowCeiling = Math.max(c.zValley + 300, c.zObs);
  const lowCoverage = low.z <= c.zValley + 300 && prof.at(-1).z >= lowCeiling
    && lay.every((l) => l.z0 >= lowCeiling || l.z1 - l.z0 <= 650);
  const insufficientLow = kb < 0 && !lowCoverage;
  const incompleteEvidence = kb < 0 && r.ztop == null && c.cl == null;
  r.P = Q == null || insufficientLow || incompleteEvidence ? null
    : r.ztop != null ? 100 * Fcloud * Fheight * Q
      : noCloudEvidence ? 0 : null;
  r.diagnosis = Q == null || incompleteEvidence ? 'missing-input'
    : insufficientLow ? 'insufficient-profile'
      : r.ztop != null ? 'resolved-cloud'
      : noCloudEvidence ? 'unfavorable' : 'unresolved-cloud-top';
  r.missingFields = missingFields;
  r.diagnosisDetails = r.diagnosis === 'missing-input'
    ? `关键输入不完整：${missingFields.join(', ') || '评分因子不可计算'}`
    : insufficientLow ? '谷底至观测点的气压层覆盖不足，无法排除浅层云雾'
    : r.diagnosis === 'unresolved-cloud-top'
      ? (shallowCloudSignal ? `低云量 ${Math.round(c.cl)}%，但气压层未解析出云顶；不能把低云误判为零概率`
        : nearSurfaceSaturation ? `近地相对湿度 ${Math.round(c.rh2)}%，可能存在未解析的浅层雾；云顶未知`
          : '检测到低云或谷雾线索，但气压层无法确定云顶上界；不强行给出评分')
      : r.diagnosis === 'unfavorable'
        ? `气压层未检出低云，低云量 ${Math.round(c.cl)}% 且谷雾诊断偏弱；规则评分 0 不代表绝对不会出现云海`
        : r.P === 0 && r.margin != null && r.margin <= -200
          ? '诊断云顶高于观测点至少 200 m：此处无法俯瞰云海，条件评分为零'
          : '已由成云、云顶高差、封盖、上空通透、风和降水因子计算条件评分';
  return r;
}

/**
 * 日出可见度与朝霞指数
 * c: { zObs, alphaDeg, sea, cm, ch, precip, samples:[{x,cl,cm,ch}], aod }
 */
export function analyzeSunrise(c) {
  const hasDirectionCloud = Array.isArray(c.samples) && c.samples.length >= 3
    && c.samples.every((s) => s.cl != null && s.cm != null && s.ch != null);
  const lowTop = c.sea?.type === 'A' && c.sea.ztop != null ? clamp(c.sea.ztop, 800, 3000) : 2000;
  const per = c.samples.map((s) => {
    const H = rayHeight(s.x, c.zObs, c.alphaDeg);
    const layers = [[s.cl, 0, lowTop, 1], [s.cm, 3000, 8000, 0.85], [s.ch, 8000, 12000, 0.35]];
    let t = 1;
    for (const [cov, base, top, w] of layers) {
      if (cov == null) continue;
      t *= 1 - w * (cov / 100) * clamp((top - H) / (top - base));
    }
    return { x: s.x, H, t, cl: s.cl, cm: s.cm, ch: s.ch };
  });
  const meanLn = (arr) => (arr.length ? arr.reduce((a, p) => a + Math.log(Math.max(p.t, 0.02)), 0) / arr.length : 0);
  const Ptrans = hasDirectionCloud ? Math.exp(1.5 * meanLn(per)) : null;

  let inCloud = 0;
  if (c.sea?.margin != null) inCloud = piecewise(c.sea.margin, [[-150, 1], [0, 0.6], [80, 0]]) * clamp((c.sea.f.cloud ?? 0) * 1.2);
  if (c.sea?.rhObs != null) inCloud = Math.max(inCloud, piecewise(c.sea.rhObs, [[93, 0], [98, 0.7], [100, 0.9]]));

  const Fp = c.precip == null ? null : piecewise(c.precip, [[0, 1], [0.1, 0.8], [0.5, 0.35], [2, 0.1]]);
  const Pvis = Ptrans == null || Fp == null ? null : 100 * Ptrans * (1 - inCloud) * Fp;

  const canvas = c.cm == null || c.ch == null ? null : 100 * (1 - (1 - c.cm / 100) * (1 - c.ch / 100));
  const Fcanvas = canvas == null ? null : piecewise(canvas, [[0, 0.12], [15, 0.45], [30, 0.9], [60, 1], [80, 0.6], [95, 0.25], [100, 0.12]]);
  const far = per.filter((p) => p.x >= 120000);
  const farT = hasDirectionCloud && far.length ? Math.exp(meanLn(far)) : null;
  const Faer = c.aod == null ? 0.85
    : piecewise(c.aod, [[0, 0.75], [0.08, 0.95], [0.15, 1], [0.35, 0.95], [0.6, 0.6], [1, 0.3], [2, 0.12]]);
  const glow = Fcanvas == null || farT == null || Fp == null ? null
    : 100 * Fcanvas * farT ** 0.8 * Faer * Fp * (1 - 0.7 * inCloud);
  return { Pvis, glow, Ptrans, farT, inCloud, canvas, Fcanvas, Faer, per, lowTop };
}

export function stats(arr) {
  const v = arr.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return { mean: null, min: null, max: null, n: 0, sd: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, min: Math.min(...v), max: Math.max(...v), n: v.length, sd };
}

// 地形遮挡后的视地平高度角
export function terrainHorizon(profile, zEye) {
  let best = -90;
  let at = null;
  for (const p of profile) {
    if (p.z == null || p.x < 500) continue;
    const a = terrainAngle(p.x, p.z, zEye);
    if (a > best) { best = a; at = p; }
  }
  return { angle: best, at };
}

export function dayList(fc) {
  const seen = new Map();
  fc.localTimes.forEach((s, i) => {
    const key = s.slice(0, 10);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(i);
  });
  return [...seen.entries()].map(([key, idx]) => {
    const [y, m, d] = key.split('-').map(Number);
    return { key, idx, midnight: Date.UTC(y, m - 1, d) - fc.offset * 1000 };
  });
}

// 计算每天的日出几何（海平面、山顶眼高差、地形遮挡）
export function sunriseGeometry(site, midnight, terrain) {
  const zEye = site.zObs + 2;
  const dip = horizonDip(zEye);
  const sea = findRise(midnight, midnight + 16 * 3600e3, site.lat, site.lon, -0.833);
  const summit = findRise(midnight, midnight + 16 * 3600e3, site.lat, site.lon, sunriseGeometricTarget(-dip));
  const th = terrain?.length ? terrainHorizon(terrain, zEye) : { angle: -90, at: null };
  const alpha = Math.max(-dip, th.angle);
  const actual = findRise(midnight, midnight + 16 * 3600e3, site.lat, site.lon, sunriseGeometricTarget(alpha));
  return { sea, summit, actual, dip, alpha, terrainAngle: th.angle, terrainAt: th.at, blocked: th.angle > -dip };
}

function nearestIdx(times, t) {
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
  return best;
}

/**
 * 主流程
 * fc: 规范化的多模式预报；site: {lat,lon,zObs,zValley}
 * horizon: {times, points:[{day, x, models:{id:{cl,cm,ch}}}]}
 * aq: {times, aod, pm25, dust} | null
 * terrain: [{x,z}] 沿日出方位的地形剖面
 */
export function runForecast({ fc, site, horizon, aq, terrain }) {
  const models = fc.models.filter((m) => m.available);
  const sunEl = fc.times.map((t) => solarPosition(t, site.lat, site.lon).elevation);

  const hours = fc.times.map((t, i) => {
    const per = {};
    for (const m of models) {
      const s = m.surf;
      let rain24 = 0;
      for (let j = Math.max(0, i - 24); j < i; j++) {
        const rain = s.precip?.[j];
        if (rain == null) { rain24 = null; break; }
        rain24 += rain;
      }
      const prof = buildProfile(m, i, site.zValley);
      const res = analyzeCloudSea(prof, {
        zObs: site.zObs, zValley: site.zValley,
        cl: s.cl?.[i] ?? null, rh2: s.RH2?.[i] ?? null,
        cm: s.cm?.[i], ch: s.ch?.[i], precip: s.precip?.[i] ?? null,
        rain24, sunElev: sunEl[i], wind10: s.wind10?.[i],
      });
      res.prof = prof;
      per[m.id] = res;
    }
    const st = stats(Object.values(per).map((r) => r.P));
    const zt = stats(Object.values(per).map((r) => r.ztop));
    return { t, local: fc.localTimes[i], sunEl: sunEl[i], models: per, P: st, ztop: zt };
  });

  const aqAt = (t) => {
    if (!aq?.times?.length) return { aod: null, pm25: null, dust: null };
    const k = nearestIdx(aq.times, t);
    if (Math.abs(aq.times[k] - t) > 2 * 3600e3) return { aod: null, pm25: null, dust: null };
    return { aod: aq.aod?.[k] ?? null, pm25: aq.pm25?.[k] ?? null, dust: aq.dust?.[k] ?? null };
  };

  const now = Date.now();
  const days = dayList(fc)
    .map((d, dayIndex) => {
      const geo = sunriseGeometry(site, d.midnight, terrain);
      const rise = geo.actual ?? geo.summit ?? geo.sea;
      if (!rise) return null;
      const riseIdx = nearestIdx(fc.times, rise.time);
      const win = d.idx.filter((i) => fc.times[i] >= rise.time - 100 * 60e3 && fc.times[i] <= rise.time + 50 * 60e3);
      const bestIdx = win.reduce((best, i) => {
      const candidate = hours[i].P;
      if (candidate.mean == null) return best;
      if (best == null) return i;
      const current = hours[best].P;
      return candidate.mean > current.mean || (candidate.mean === current.mean && candidate.n > current.n) ? i : best;
    }, null);
    const cloudHour = hours[bestIdx ?? riseIdx];
    const air = aqAt(rise.time);
      const hp = horizon?.points?.filter((p) => p.day === dayIndex) ?? [];
      const hk = horizon?.times?.length ? nearestIdx(horizon.times, rise.time) : -1;

      const per = {};
      for (const m of models) {
        const seaAtBest = cloudHour.models[m.id];
        const seaAtRise = hours[riseIdx].models[m.id];
        const s = m.surf;
        const samples = hp.map((p) => ({
          x: p.x,
          cl: p.models[m.id]?.cl?.[hk] ?? null,
          cm: p.models[m.id]?.cm?.[hk] ?? null,
          ch: p.models[m.id]?.ch?.[hk] ?? null,
        })).filter((p) => p.cl != null || p.cm != null);
        const sun = analyzeSunrise({
          zObs: site.zObs, alphaDeg: geo.alpha, sea: seaAtRise,
          cm: s.cm?.[riseIdx], ch: s.ch?.[riseIdx], precip: s.precip?.[riseIdx] ?? null,
          samples, aod: air.aod,
        });
        if (geo.blocked && sun.Pvis != null) sun.Pvis *= piecewise(geo.terrainAngle + geo.dip, [[0, 1], [1, 0.9], [3, 0.75]]);
        const T2 = s.T2?.[riseIdx];
        const ws = seaAtRise?.wsObs ?? s.wind10?.[riseIdx];
        per[m.id] = {
          sea: bestIdx == null ? null : seaAtBest.P,
          seaAtBest, seaAtRise, sun,
          hike: {
            T: T2, ws, gust: s.gust?.[riseIdx], feels: T2 != null && ws != null ? windChill(T2, ws) : null,
            frz: s.frz?.[riseIdx], vis: s.vis?.[riseIdx], precip: s.precip?.[riseIdx],
          },
        };
      }
      const V = Object.values(per);
      const scored = V.map((v) => v.seaAtBest).filter((r) => bestIdx != null && Number.isFinite(r.P));
      const typeVotes = {};
      scored.forEach(({ type }) => { typeVotes[type] = (typeVotes[type] ?? 0) + 1; });
      return {
        key: d.key, idx: d.idx, geo, rise, riseIdx, win, bestIdx, air, models: per,
        past: rise.time < now - 3600e3,
        sea: stats(V.map((v) => v.sea)),
        vis: stats(V.map((v) => v.sun.Pvis)),
        glow: stats(V.map((v) => v.sun.glow)),
        ztop: stats(scored.map((r) => r.ztop)),
        cap: stats(scored.map((r) => r.cap)),
        type: Object.entries(typeVotes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none',
        afterRain: scored.some((r) => r.notes.includes('afterRain')),
        hike: {
          T: stats(V.map((v) => v.hike.T)), feels: stats(V.map((v) => v.hike.feels)),
          ws: stats(V.map((v) => v.hike.ws)), gust: stats(V.map((v) => v.hike.gust)),
          frz: stats(V.map((v) => v.hike.frz)), precip: stats(V.map((v) => v.hike.precip)),
        },
        factors: Object.fromEntries(['cloud', 'height', 'cap', 'dry', 'wind', 'precip']
          .map((k) => [k, stats(scored.map((r) => r.f[k]))])),
      };
    })
    .filter(Boolean);

  return { hours, days, models: models.map((m) => m.id) };
}
