// 图表：逐小时时间轴、垂直廓线（探空图）、日出光路剖面
/* global Chart */
import { rayHeight } from './sun.js';
import { MODELS } from './model.js';

const mName = (id) => MODELS.find((m) => m.id === id)?.name ?? id;

Chart.defaults.color = '#b9c4d6';
Chart.defaults.borderColor = 'rgba(255,255,255,0.08)';
Chart.defaults.font.family = '"PingFang SC","Microsoft YaHei",system-ui,sans-serif';

const charts = {};
const MODEL_COLORS = {
  ecmwf_ifs025: '#6ec6ff', gfs_seamless: '#ff8a65', icon_seamless: '#9ccc65', cma_grapes_global: '#f06292', jma_seamless: '#ffd54f',
};
export const modelColor = (id) => MODEL_COLORS[id] ?? '#ccc';

function make(id, cfg) {
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), cfg);
  return charts[id];
}

const fmtTime = (t, off) => {
  const d = new Date(t + off * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}时`;
};

export function drawTimeline(res, offset, { selected, onSelect, nowMs }) {
  const H = res.hours.filter((h) => h.t >= nowMs - 30 * 3600e3);
  const pts = (fn) => H.map((h) => ({ x: h.t, y: fn(h) }));
  const ds = [
    { label: '模式范围(上)', data: pts((h) => h.P.max), borderWidth: 0, pointRadius: 0, backgroundColor: 'rgba(130,180,255,0.18)', fill: '+1' },
    { label: '模式范围(下)', data: pts((h) => h.P.min), borderWidth: 0, pointRadius: 0, fill: false },
    { label: '云海概率（集合平均）', data: pts((h) => h.P.mean), borderColor: '#e8f1ff', borderWidth: 2.2, pointRadius: 0, tension: 0.25 },
    ...res.models.map((m) => ({
      label: mName(m), data: pts((h) => h.models[m]?.P ?? null), borderColor: modelColor(m), borderWidth: 1, pointRadius: 0, borderDash: [3, 3], hidden: false, tension: 0.2,
    })),
    {
      label: '日出', type: 'bar', data: res.days.map((d) => ({ x: d.rise.time, y: 100 })), backgroundColor: 'rgba(255,170,60,0.55)', barThickness: 3, yAxisID: 'y',
    },
  ];
  const sel = selected != null ? res.hours[selected]?.t : null;
  make('chart-timeline', {
    type: 'line',
    data: { datasets: ds },
    options: {
      animation: false, maintainAspectRatio: false, parsing: false, normalized: true,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: { type: 'linear', min: H[0]?.t, max: H[H.length - 1]?.t, ticks: { stepSize: 6 * 3600e3, callback: (v) => fmtTime(v, offset), maxRotation: 0, autoSkip: true } },
        y: { min: 0, max: 100, title: { display: true, text: '云海概率 %' } },
      },
      plugins: {
        legend: { labels: { boxWidth: 10, filter: (it) => !it.text.startsWith('模式范围') } },
        tooltip: { callbacks: { title: (it) => fmtTime(it[0].parsed.x, offset), label: (c) => `${c.dataset.label}: ${c.parsed.y?.toFixed?.(0)}` } },
      },
      onClick: (e, els, chart) => {
        const x = chart.scales.x.getValueForPixel(e.x);
        let best = 0;
        res.hours.forEach((h, i) => { if (Math.abs(h.t - x) < Math.abs(res.hours[best].t - x)) best = i; });
        onSelect?.(best);
      },
    },
    plugins: [{
      id: 'cursor',
      afterDraw(c) {
        if (sel == null) return;
        const x = c.scales.x.getPixelForValue(sel);
        const { top, bottom } = c.chartArea;
        c.ctx.save();
        c.ctx.strokeStyle = '#ffd84d'; c.ctx.lineWidth = 1.5; c.ctx.setLineDash([4, 3]);
        c.ctx.beginPath(); c.ctx.moveTo(x, top); c.ctx.lineTo(x, bottom); c.ctx.stroke();
        c.ctx.restore();
      },
    }],
  });
}

export function drawProfile(hour, site, modelId) {
  const r = hour.models[modelId];
  const prof = r?.prof ?? [];
  const zmax = Math.max(site.zObs + 1500, 3500);
  const P = prof.filter((l) => l.z <= zmax + 500);
  const xs = P.flatMap((l) => [l.T, l.Td]);
  const xmin = Math.floor(Math.min(...xs, 0) - 3);
  const xmax = Math.ceil(Math.max(...xs, 10) + 3);
  const hline = (y, label, color, dash = []) => ({ label, data: [{ x: xmin, y }, { x: xmax, y }], borderColor: color, borderDash: dash, borderWidth: 1.5, pointRadius: 0 });
  const ds = [
    { label: '气温 T', data: P.map((l) => ({ x: l.T, y: l.z })), borderColor: '#ff7b6b', backgroundColor: '#ff7b6b', borderWidth: 2.2, pointRadius: 3 },
    { label: '露点 Td', data: P.map((l) => ({ x: l.Td, y: l.z })), borderColor: '#5fc3ff', backgroundColor: '#5fc3ff', borderWidth: 2, pointRadius: 3 },
    { label: '相对湿度 RH', data: P.map((l) => ({ x: l.RH, y: l.z })), xAxisID: 'x2', borderColor: 'rgba(170,230,170,0.8)', backgroundColor: 'rgba(170,230,170,0.15)', fill: { target: { value: 0 } }, borderWidth: 1, pointRadius: 0 },
    hline(site.zObs, `观测点 ${Math.round(site.zObs)} m`, '#ffd84d'),
    hline(site.zValley, `谷底 ${Math.round(site.zValley)} m`, '#9a7b5b', [5, 4]),
  ];
  if (r?.ztop != null) ds.push(hline(r.ztop, `云顶 ${Math.round(r.ztop)} m`, '#ffffff', [2, 3]));
  make('chart-profile', {
    type: 'line',
    data: { datasets: ds },
    options: {
      animation: false, maintainAspectRatio: false, parsing: false,
      scales: {
        x: { type: 'linear', min: xmin, max: xmax, title: { display: true, text: '温度 °C' } },
        x2: { type: 'linear', position: 'top', min: 0, max: 100, grid: { display: false }, title: { display: true, text: 'RH %' } },
        y: { type: 'linear', min: Math.max(0, site.zValley - 200), max: zmax, title: { display: true, text: '海拔 m' } },
      },
      plugins: { legend: { labels: { boxWidth: 10 } } },
    },
  });
}

export function drawHorizon(day, site, terrain, modelId) {
  const m = day.models[modelId] ?? Object.values(day.models)[0];
  if (!m) return;
  const per = m.sun.per;
  const alpha = day.geo.alpha;
  const xs = [];
  for (let x = 0; x <= 300000; x += 5000) xs.push(x);
  const lowTop = m.sun.lowTop;
  const cloudPts = (key, y, color) => ({
    label: key === 'cl' ? `低云(≤${Math.round(lowTop)} m)` : key === 'cm' ? '中云(3–8 km)' : '高云(>8 km)',
    type: 'bubble',
    data: per.map((p) => ({ x: p.x / 1000, y, r: 3 + ((p[key] ?? 0) / 100) * 16, v: p[key] })),
    backgroundColor: color, borderColor: 'rgba(255,255,255,0.5)', borderWidth: 1,
  });
  make('chart-horizon', {
    type: 'line',
    data: {
      datasets: [
        { label: '地形剖面', data: terrain.map((p) => ({ x: p.x / 1000, y: p.z })), borderColor: '#a07850', backgroundColor: 'rgba(120,90,60,0.55)', fill: 'origin', pointRadius: 0, borderWidth: 1 },
        { label: '日出光线高度', data: xs.map((x) => ({ x: x / 1000, y: rayHeight(x, site.zObs + 2, alpha) })), borderColor: '#ffb347', borderWidth: 2, pointRadius: 0, borderDash: [6, 3] },
        cloudPts('cl', lowTop / 2, 'rgba(235,240,250,0.75)'),
        cloudPts('cm', 5500, 'rgba(170,185,210,0.7)'),
        cloudPts('ch', 9500, 'rgba(140,170,230,0.55)'),
      ],
    },
    options: {
      animation: false, maintainAspectRatio: false, parsing: false,
      scales: {
        x: { type: 'linear', min: 0, max: 300, title: { display: true, text: `沿日出方位 ${day.rise.azimuth.toFixed(1)}° 的距离 km` } },
        y: { min: 0, max: 11000, title: { display: true, text: '海拔 m' } },
      },
      plugins: {
        legend: { labels: { boxWidth: 10 } },
        tooltip: { callbacks: { label: (c) => (c.raw.v != null ? `${c.dataset.label}: ${Math.round(c.raw.v)}%` : `${c.dataset.label}: ${Math.round(c.parsed.y)} m`) } },
      },
    },
  });
}

// 云层高度走势：云底–云顶（集合平均）、云顶模式范围、观测点与谷底海拔、云海概率
export function drawCloudLayer(res, site, offset, { selected, onSelect, nowMs, agg }) {
  const H = res.hours.map((h, i) => ({ h, i })).filter(({ h }) => h.t >= nowMs - 30 * 3600e3);
  const on = ({ h }) => (h.P.mean ?? 0) >= 8 && h.ztop.mean != null;
  const pts = (fn) => H.map((o) => ({ x: o.h.t, y: on(o) ? fn(o) : null }));
  const flat = (y) => [{ x: H[0]?.h.t, y }, { x: H[H.length - 1]?.h.t, y }];
  const ds = [
    { label: '云顶范围(上)', data: pts(({ h }) => h.ztop.max), borderWidth: 0, pointRadius: 0, backgroundColor: 'rgba(238,243,251,0.16)', fill: '+1', spanGaps: false },
    { label: '云顶范围(下)', data: pts(({ h }) => h.ztop.min), borderWidth: 0, pointRadius: 0, fill: false, spanGaps: false },
    { label: '云顶（集合平均）', data: pts(({ h }) => h.ztop.mean), borderColor: '#f4f7fd', borderWidth: 2, pointRadius: 0, backgroundColor: 'rgba(238,243,251,0.42)', fill: '+1', spanGaps: false, tension: 0.25 },
    { label: '云底', data: pts(({ i }) => agg(i).zbase.mean), borderColor: 'rgba(200,210,230,0.6)', borderWidth: 1, borderDash: [3, 3], pointRadius: 0, spanGaps: false, tension: 0.25 },
    { label: `观测点 ${Math.round(site.zObs)} m`, data: flat(site.zObs), borderColor: '#ffd84d', borderWidth: 1.6, pointRadius: 0 },
    { label: `谷底 ${Math.round(site.zValley)} m`, data: flat(site.zValley), borderColor: '#9a7b5b', borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 },
    { label: '云海概率', type: 'bar', yAxisID: 'yP', data: H.map(({ h }) => ({ x: h.t, y: h.P.mean ?? 0 })), backgroundColor: 'rgba(127,178,229,0.28)', barPercentage: 1, categoryPercentage: 1, barThickness: 'flex' },
  ];
  const sel = selected != null ? res.hours[selected]?.t : null;
  const tops = H.filter(on).map(({ h }) => h.ztop.max);
  const ymax = Math.max(site.zObs + 400, ...tops.map((z) => z + 200));
  const make2 = (id, cfg) => { charts[id]?.destroy(); charts[id] = new Chart(document.getElementById(id), cfg); };
  make2('chart-cloudlayer', {
    type: 'line',
    data: { datasets: ds },
    options: {
      animation: false, maintainAspectRatio: false, parsing: false, normalized: true,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: { type: 'linear', min: H[0]?.h.t, max: H[H.length - 1]?.h.t, ticks: { stepSize: 6 * 3600e3, callback: (v) => fmtTime(v, offset), maxRotation: 0, autoSkip: true } },
        y: { min: Math.max(0, Math.floor((site.zValley - 250) / 100) * 100), max: Math.ceil(ymax / 100) * 100, title: { display: true, text: '海拔 m' } },
        yP: { position: 'right', min: 0, max: 100, grid: { display: false }, title: { display: true, text: '云海概率 %' } },
      },
      plugins: {
        legend: { labels: { boxWidth: 10, filter: (it) => !it.text.startsWith('云顶范围') } },
        tooltip: { callbacks: { title: (it) => fmtTime(it[0].parsed.x, offset), label: (c) => (c.parsed.y == null ? null : `${c.dataset.label}: ${Math.round(c.parsed.y)}${c.dataset.yAxisID === 'yP' ? '%' : ' m'}`) } },
      },
      onClick: (e, els, chart) => {
        const x = chart.scales.x.getValueForPixel(e.x);
        let best = 0;
        res.hours.forEach((h, i) => { if (Math.abs(h.t - x) < Math.abs(res.hours[best].t - x)) best = i; });
        onSelect?.(best);
      },
    },
    plugins: [{
      id: 'cursor2',
      afterDraw(c) {
        if (sel == null) return;
        const x = c.scales.x.getPixelForValue(sel);
        const { top, bottom } = c.chartArea;
        c.ctx.save();
        c.ctx.strokeStyle = '#ffd84d'; c.ctx.lineWidth = 1.5; c.ctx.setLineDash([4, 3]);
        c.ctx.beginPath(); c.ctx.moveTo(x, top); c.ctx.lineTo(x, bottom); c.ctx.stroke();
        c.ctx.restore();
      },
    }],
  });
}
