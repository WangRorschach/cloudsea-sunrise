// 云海详细预报：逐小时集合诊断汇总、云海时段识别、7×24 热力图、逐时表、周边观景点与云顶对比、覆盖面积
import { MODELS, stats } from './model.js';
import { fetchElevations } from './data.js';
import { destination } from './sun.js';

const r0 = (x, s = '') => (x == null || Number.isNaN(x) ? '—' : `${Math.round(x)}${s}`);
const r1 = (x, s = '') => (x == null || Number.isNaN(x) ? '—' : `${x.toFixed(1)}${s}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mName = (id) => MODELS.find((m) => m.id === id)?.name ?? id;

export const TYPE_TXT = { A: '层积云型云海', B: '辐射雾 / 谷雾型', none: '无' };
const LIMIT_TXT = {
  cloud: '低层水汽不足，未达饱和成云',
  height: '云顶接近或高于观测点（会身处云中）',
  cap: '缺少逆温封盖，云面不稳定',
  dry: '观测点上空偏湿或有中云遮挡',
  wind: '观测高度风大，云面易被吹散',
  precip: '有降水',
};
const SEA_ON = 20; // 集合概率 ≥20% 记为“有云海”时段

// 某一小时的多模式汇总
export function hourAgg(res, fc, i) {
  const h = res.hours[i];
  const V = Object.entries(h.models);
  const surf = (k) => stats(V.map(([id]) => fc.models.find((m) => m.id === id)?.surf?.[k]?.[i]));
  const votes = {};
  V.forEach(([, r]) => { if ((r.P ?? 0) >= 8) votes[r.type] = (votes[r.type] ?? 0) + 1; });
  const type = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
  const withCloud = V.filter(([, r]) => r.ztop != null && (r.P ?? 0) >= 8);
  const fMean = (k) => stats(V.map(([, r]) => r.f?.[k])).mean;
  const f = Object.fromEntries(Object.keys(LIMIT_TXT).map((k) => [k, fMean(k)]));
  // 没有成云时“高度裕度”无意义（无云顶），此时限制因子归为成云条件
  const cand = Object.entries(f).filter(([k, v]) => v != null && !(k === 'height' && (f.cloud ?? 0) <= 0.1));
  const limit = cand.sort((a, b) => a[1] - b[1])[0];
  return {
    i, t: h.t, local: h.local, sunEl: h.sunEl, P: h.P, type,
    ztop: stats(withCloud.map(([, r]) => r.ztop)),
    zbase: stats(withCloud.map(([, r]) => r.zbase)),
    rh: stats(V.map(([, r]) => r.rhObs)),
    cap: stats(V.map(([, r]) => r.cap)),
    ws: stats(V.map(([, r]) => r.wsObs)),
    cl: surf('cl'), cm: surf('cm'), precip: surf('precip'), T2: surf('T2'),
    f, limit: limit ? { key: limit[0], v: limit[1], txt: LIMIT_TXT[limit[0]] } : null,
    perModel: Object.fromEntries(V.map(([id, r]) => [id, r.P])),
  };
}

// 某日（当地日期）的云海时段
export function dayEpisodes(res, fc, key) {
  const idx = res.hours.map((h, i) => (h.local.startsWith(key) ? i : -1)).filter((i) => i >= 0);
  const eps = [];
  let cur = null;
  for (const i of idx) {
    const p = res.hours[i].P.mean ?? 0;
    if (p >= SEA_ON) {
      if (!cur) cur = { start: i, end: i, peak: i };
      cur.end = i;
      if (p > (res.hours[cur.peak].P.mean ?? 0)) cur.peak = i;
    } else if (cur) { eps.push(cur); cur = null; }
  }
  if (cur) eps.push(cur);
  return eps.map((e) => {
    const hs = [];
    for (let i = e.start; i <= e.end; i++) hs.push(hourAgg(res, fc, i));
    const pk = hourAgg(res, fc, e.peak);
    return {
      ...e, peakAgg: pk,
      ztop: stats(hs.flatMap((h) => [h.ztop.min, h.ztop.max])),
      zbase: stats(hs.map((h) => h.zbase.mean)),
      type: pk.type,
      clearAt: e.end + 1 < res.hours.length ? res.hours[e.end + 1].t : null,
    };
  });
}

const hh = (local) => local.slice(11, 13);

// 热力图色阶：深夜蓝 → 灰蓝 → 云白（≥70% 略带暖色，表示“很可能”）
const STOPS = [[0, [24, 35, 58]], [10, [38, 55, 86]], [25, [70, 98, 140]], [45, [140, 168, 205]], [65, [222, 232, 246]], [85, [255, 246, 222]]];
function heatColor(p, night) {
  let k = 1;
  while (k < STOPS.length - 1 && p > STOPS[k][0]) k++;
  const [p0, c0] = STOPS[k - 1];
  const [p1, c1] = STOPS[k];
  const t = Math.max(0, Math.min(1, (p - p0) / (p1 - p0)));
  const c = c0.map((v, j) => Math.round((v + (c1[j] - v) * t) * (night && p < 25 ? 0.82 : 1)));
  return `rgb(${c.join(',')})`;
}

// 当日文字总结
export function summaryHtml(res, fc, site, day, hm) {
  const eps = dayEpisodes(res, fc, day.key);
  const riseAgg = hourAgg(res, fc, day.riseIdx);
  const out = [];
  if (!eps.length) {
    const pk = day.idx.reduce((a, b) => ((res.hours[b].P.mean ?? 0) > (res.hours[a].P.mean ?? 0) ? b : a), day.idx[0]);
    const a = hourAgg(res, fc, pk);
    out.push(`<p class="cs-lead none">当天<b>没有明显的云海时段</b>（全天集合概率均低于 ${SEA_ON}%，最高 ${r0(a.P.mean, '%')}，出现在 ${hh(a.local)} 时）。</p>`);
    if (a.limit) out.push(`<p>主要限制因子：<b>${a.limit.txt}</b>（因子值 ${a.limit.v.toFixed(2)}，1 为最有利）。</p>`);
  } else {
    out.push(`<p class="cs-lead">当天有 <b>${eps.length}</b> 个云海时段：</p><ol class="cs-eps">${eps.map((e) => {
      const H = res.hours;
      const pk = e.peakAgg;
      const rel = e.ztop.mean != null ? site.zObs - e.ztop.mean : null;
      const relTxt = rel == null ? '' : rel >= 0 ? `，比观测点<b>低约 ${r0(rel)} m</b>（可俯瞰）` : `，<b>高于观测点 ${r0(-rel)} m</b>（会身处云中）`;
      const models = Object.entries(pk.perModel).map(([id, p]) => `${mName(id)} ${r0(p)}%`).join('、');
      return `<li><b>${hh(H[e.start].local)}:00 – ${hh(H[e.end].local)}:59</b> · ${TYPE_TXT[e.type]}<br>
        云顶 <b>${r0(e.ztop.min)}–${r0(e.ztop.max)} m</b>${e.zbase.mean != null ? `，云底约 ${r0(e.zbase.mean)} m` : ''}${relTxt}。<br>
        峰值 <b>${hh(pk.local)} 时 ${r0(pk.P.mean, '%')}</b>（${models}）${e.clearAt ? `；预计 ${hm(e.clearAt)} 前后减弱` : ''}。</li>`;
    }).join('')}</ol>`);
  }
  out.push(`<p>日出 ${hm(day.rise.time)} 时：云海概率 <b>${r0(riseAgg.P.mean, '%')}</b>（模式范围 ${r0(riseAgg.P.min)}–${r0(riseAgg.P.max)}%）${riseAgg.ztop.mean != null && (riseAgg.P.mean ?? 0) >= 8 ? `，云顶 ${r0(riseAgg.ztop.mean)} m` : ''}；观测高度相对湿度 ${r0(riseAgg.rh.mean, '%')}，低云量 ${r0(riseAgg.cl.mean, '%')}${riseAgg.limit && (riseAgg.P.mean ?? 0) < 40 ? `；最主要的限制是“${riseAgg.limit.txt}”` : ''}。</p>`);
  return out.join('');
}

// 7×24 热力图
export function heatmapHtml(res, days, { selected, dayLabel, relDay }) {
  const byKey = new Map();
  res.hours.forEach((h, i) => byKey.set(h.local.slice(0, 13), i));
  const head = `<div class="hm-row hm-head"><span></span>${Array.from({ length: 24 }, (_, k) => `<span>${k % 3 === 0 ? k : ''}</span>`).join('')}</div>`;
  const rows = days.map((d) => {
    const L = dayLabel(d.key);
    const riseH = res.hours[d.riseIdx].local.slice(11, 13);
    const cells = Array.from({ length: 24 }, (_, k) => {
      const key = `${d.key}T${String(k).padStart(2, '0')}`;
      const i = byKey.get(key);
      if (i == null) return '<span class="hm-c na"></span>';
      const h = res.hours[i];
      const p = h.P.mean ?? 0;
      const zt = h.ztop.mean;
      const night = h.sunEl < -6;
      const tip = `${L.md} ${k}时 · 云海 ${Math.round(p)}%（${r0(h.P.min)}–${r0(h.P.max)}%）${zt != null && p >= 8 ? ` · 云顶 ${Math.round(zt)} m` : ''}`;
      return `<span class="hm-c${night ? ' night' : ''}${k === +riseH ? ' rise' : ''}${i === selected ? ' sel' : ''}" data-i="${i}" title="${tip}" style="background:${heatColor(p, night)};color:${p >= 45 ? '#0b1220' : '#dfe8f6'}">${p >= 15 ? Math.round(p) : ''}</span>`;
    }).join('');
    return `<div class="hm-row${d.past ? ' past' : ''}"><span class="hm-d">${relDay(d.key) ?? L.w}<small>${L.md}</small></span>${cells}</div>`;
  }).join('');
  return head + rows;
}

// 某日逐小时表（00–12 时 + 前一晚 21–23 时）
export function hourTableHtml(res, fc, site, day, selected) {
  const first = Math.max(0, day.idx[0] - 3);
  const last = day.idx.find((i) => res.hours[i].local.endsWith('12:00')) ?? day.idx[day.idx.length - 1];
  const rows = [];
  for (let i = first; i <= last; i++) {
    const a = hourAgg(res, fc, i);
    const p = a.P.mean ?? 0;
    const has = p >= 8 && a.ztop.mean != null;
    const rel = has ? site.zObs - a.ztop.mean : null;
    const pos = !has ? '—' : rel >= 150 ? `<span class="ok">云上 +${r0(rel)}</span>` : rel >= 0 ? `<span class="warn">贴近 +${r0(rel)}</span>` : `<span class="bad">云中 ${r0(rel)}</span>`;
    const thick = has && a.zbase.mean != null ? a.ztop.mean - a.zbase.mean : null;
    rows.push(`<tr data-i="${i}" class="${i === day.riseIdx ? 'rise' : ''}${i === selected ? ' sel' : ''}">
      <td>${a.local.slice(5, 10).replace('-', '/')} <b>${hh(a.local)}时</b>${i === day.riseIdx ? ' <i class="rise-dot" title="日出">☀</i>' : ''}</td>
      <td>${r0(a.sunEl, '°')}</td>
      <td><span class="pbar" style="--p:${p / 100}"><b>${r0(p)}</b></span><small>${r0(a.P.min)}–${r0(a.P.max)}</small></td>
      <td>${has ? TYPE_TXT[a.type].replace('云海', '').replace(' / 谷雾型', '') : '—'}</td>
      <td>${has ? `${r0(a.zbase.mean)}–${r0(a.ztop.mean)}` : '—'}</td>
      <td>${r0(thick)}</td>
      <td>${pos}</td>
      <td>${r0(a.cl.mean, '%')}</td>
      <td>${r0(a.rh.mean, '%')}</td>
      <td>${r1(a.cap.mean)}</td>
      <td>${r1(a.ws.mean)}</td>
      <td>${r1(a.precip.mean)}</td>
      <td class="lim">${p >= 60 ? '<span class="ok">条件理想</span>' : a.limit ? esc(a.limit.txt) : '—'}</td>
    </tr>`);
  }
  return `<table class="cs-table"><thead><tr><th>时刻</th><th>太阳</th><th>云海概率 %</th><th>类型</th><th>云底–云顶 m</th><th>厚度 m</th><th>观测点相对云顶</th><th>低云量</th><th>山顶 RH</th><th>逆温 K/km</th><th>风 m/s</th><th>降水 mm</th><th>主要限制</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// 观测点周边地形网格（半径 10 km，用于估算云海覆盖面积与露出云面的山峰）
export async function fetchGrid(site) {
  const pts = [];
  for (let r = 1000; r <= 10000; r += 1000) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / 1100));
    for (let k = 0; k < n; k++) pts.push(destination(site.lat, site.lon, (360 * k) / n, r));
  }
  const z = await fetchElevations(pts, pts.map(() => 11));
  return z.filter((x) => x != null && Number.isFinite(x));
}

export function coverage(grid, ztop) {
  if (!grid?.length || ztop == null) return null;
  return grid.filter((z) => z < ztop).length / grid.length;
}

// 周边观景点：OSM 山峰/观景台/客栈/索道站，海拔缺失时用 DEM 补
export async function nearbySpots(site, pois, km = 12) {
  const dist = (p) => {
    const r = Math.PI / 180;
    return Math.hypot((p.lon - site.lon) * r * Math.cos(site.lat * r), (p.lat - site.lat) * r) * 6371;
  };
  const seen = new Set();
  const list = pois
    .filter((p) => ['peak', 'view', 'stay', 'lift'].includes(p.group))
    .map((p) => ({ ...p, km: dist(p) }))
    .filter((p) => p.km <= km && !seen.has(p.name) && seen.add(p.name))
    .sort((a, b) => a.km - b.km)
    .slice(0, 60);
  const miss = list.filter((p) => p.ele == null);
  if (miss.length) {
    try {
      const z = await fetchElevations(miss.map((p) => [p.lat, p.lon]), miss.map(() => 12));
      miss.forEach((p, k) => { p.ele = z[k] != null ? Math.round(z[k]) : null; p.eleSrc = 'DEM'; });
    } catch { /* 忽略 */ }
  }
  return list.filter((p) => p.ele != null);
}

export function spotsHtml(spots, a, site) {
  if (!spots?.length) return '<p class="empty">附近 12 km 内没有收录的山峰、观景台或客栈。</p>';
  const has = (a.P.mean ?? 0) >= 8 && a.ztop.mean != null;
  const zt = a.ztop.mean;
  const rows = [...spots].sort((x, y) => y.ele - x.ele).slice(0, 16).map((p) => {
    const rel = has ? p.ele - zt : null;
    const st = !has ? '<span class="muted">无云海</span>'
      : rel >= 150 ? `<span class="ok">云上 ${r0(rel)} m · 可俯瞰</span>`
        : rel >= 0 ? `<span class="warn">贴近云顶 +${r0(rel)} m</span>`
          : `<span class="bad">云中 / 云下 ${r0(rel)} m</span>`;
    return `<tr data-lat="${p.lat}" data-lon="${p.lon}" data-name="${esc(p.name)}" data-ele="${p.ele}">
      <td><span class="poi-tag g-${p.group}">${esc(p.kind)}</span> ${esc(p.name)}</td>
      <td>${r0(p.ele)}${p.eleSrc ? '<small>*</small>' : ''}</td><td>${p.km.toFixed(1)}</td><td>${st}</td></tr>`;
  }).join('');
  return `<table class="cs-spots"><thead><tr><th>地点</th><th>海拔 m</th><th>距离 km</th><th>此刻相对云顶${has ? `（${r0(zt)} m）` : ''}</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">* 海拔取自 DEM。点击一行即可改到该处预测。观测点 ${esc(site.name)} ${r0(site.zObs)} m。</p>`;
}
