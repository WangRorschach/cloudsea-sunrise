// 页面控制：加载流程、面板渲染、地图与图表联动、观测记录
/* global maplibregl */
import { MODELS, runForecast } from './model.js?v=20261116-r6';
import { findRise } from './sun.js';
import {
  fetchSiteTerrain, fetchForecast, fetchHorizon, fetchAirQuality, fetchTerrainProfile,
} from './data.js';
import { SPOTS } from './spots.js';
import * as M from './map.js';
import { drawTimeline, drawProfile, drawHorizon, drawCloudLayer, modelColor } from './charts.js';
import * as CS from './cloudsea.js';
import * as O from './obs.js';
import * as Q from './search.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = (x, s = '') => (x == null || Number.isNaN(x) ? '—' : `${Math.round(x)}${s}`);
const r1 = (x, s = '') => (x == null || Number.isNaN(x) ? '—' : `${x.toFixed(1)}${s}`);
const modelName = (id) => MODELS.find((m) => m.id === id)?.name ?? id;
const scoreText = (p) => p == null ? '—' : p > 0 && p < 0.5 ? '<1' : String(Math.round(p));
const diagnosticLabel = (r) => r?.diagnosisDetails ?? '无有效气压层或该模式暂未提供此时段资料';
const dailyDataNote = (d) => {
  const ms = Object.values(d.models ?? {});
  const unresolved = ms.filter((m) => m.seaAtBest?.diagnosis === 'unresolved-cloud-top').length;
  const missing = ms.filter((m) => ['missing-input', 'insufficient-profile'].includes(m.seaAtBest?.diagnosis)).length;
  const known = d.sea.n;
  return known ? `有效评分 ${known}/${ms.length} 模式${unresolved || missing ? ` · 云顶未解 ${unresolved} · 输入不足 ${missing}` : ''}`
    : `无法计算：云顶未解 ${unresolved} · 资料不足 ${missing}`;
};
const WEEK = '日一二三四五六';

const S = {
  site: null, res: null, fc: null, terrain: null, ter: null,
  day: 0, hour: 0, model: null, loading: 0, playTimer: null, grid: null, spots: null, aggCache: new Map(),
};
const agg = (i) => {
  if (!S.aggCache.has(i)) S.aggCache.set(i, CS.hourAgg(S.res, S.fc, i));
  return S.aggCache.get(i);
};

// ---------- 时间格式（按站点时区） ----------
const loc = (t) => new Date(t + (S.fc?.offset ?? 0) * 1000);
const hm = (t) => (t == null ? '—' : `${String(loc(t).getUTCHours()).padStart(2, '0')}:${String(loc(t).getUTCMinutes()).padStart(2, '0')}`);
const dayLabel = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { md: `${m}月${d}日`, w: `周${WEEK[w]}` };
};
const relDay = (key) => {
  const today = loc(Date.now()).toISOString().slice(0, 10);
  const diff = Math.round((Date.parse(key) - Date.parse(today)) / 864e5);
  return ['昨天', '今天', '明天', '后天'][diff + 1] ?? null;
};

// ---------- 状态提示 ----------
function status(msg, { err = false, busy = true } = {}) {
  const el = $('#status');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('err', err);
  el.innerHTML = `<div class="box">${msg}${busy ? '<div class="bar"><i></i></div>' : ''}${err ? '<div style="margin-top:12px"><button class="btn sm" id="status-retry">重试</button></div>' : ''}</div>`;
  $('#status-retry')?.addEventListener('click', () => loadSite(S.site, { fly: false }));
}

// ---------- 主流程 ----------
async function loadSite(input, { fly = true } = {}) {
  const job = ++S.loading;
  stopPlay();
  const site = { name: input.name, lat: +input.lat, lon: +input.lon, preset: input.preset ?? null, zObs: input.zObs ?? null };
  S.site = site;
  M.setSite(site, { fly });
  $('#q').value = '';
  $('#days').innerHTML = '<div class="skeleton"></div>'.repeat(5);
  $('#detail').innerHTML = '<div class="skeleton" style="height:180px"></div>';
  try {
    status('读取观测点地形（Copernicus DEM 90 m）…');
    const ter = await fetchSiteTerrain(site.lat, site.lon);
    if (job !== S.loading) return;
    S.ter = ter;
    site.dem = ter.dem;
    if (site.zObs == null) site.zObs = site.preset ?? ter.dem ?? 0;
    site.zValley = Math.min(ter.valley ?? site.zObs - 300, site.zObs - 50);
    $('#alt').value = Math.round(site.zObs);
    writeHash();
    renderSite();
    S.grid = null; S.spots = null;
    CS.fetchGrid(site).then((g) => { if (job === S.loading) { S.grid = g; if (S.res) renderCsNow(); } }).catch((e) => console.warn(e));
    Q.loadPois().then((pois) => CS.nearbySpots(site, pois)).then((sp) => { if (job === S.loading) { S.spots = sp; if (S.res) renderCsSpots(); } }).catch((e) => console.warn(e));

    status('下载 5 个全球模式的气压层廓线与地面要素…');
    const ids = MODELS.map((m) => m.id);
    const [fc, aq] = await Promise.all([
      fetchForecast(site.lat, site.lon, site.zObs, ids),
      fetchAirQuality(site.lat, site.lon).catch(() => null),
    ]);
    if (job !== S.loading) return;
    S.fc = fc;
    const pre = runForecast({ fc, site, horizon: null, aq, terrain: null });
    if (!pre.models.length) throw new Error('该位置暂无可用的模式气压层数据');
    const az = pre.days.map((d) => d.geo.sea.azimuth);
    const refAz = pre.days.find((d) => !d.past)?.geo.sea.azimuth ?? az[0];

    status('沿日出方位采样 300 km 远方云量与地形剖面…');
    const [horizon, terrain] = await Promise.all([
      fetchHorizon(site.lat, site.lon, az, pre.models).catch((e) => { console.warn(e); return null; }),
      fetchTerrainProfile(site.lat, site.lon, refAz).catch((e) => { console.warn(e); return []; }),
    ]);
    if (job !== S.loading) return;
    S.terrain = terrain;
    S.res = runForecast({ fc, site, horizon, aq, terrain });
    S.aggCache = new Map();
    S.horizonOk = !!horizon;
    O.snapshotForecast(site, S.res.days);
    S.model = S.res.models.includes(S.model) ? S.model : S.res.models[0];
    status(null);
    renderSite();
    renderModelSelect();
    const first = S.res.days.findIndex((d) => !d.past);
    selectDay(first < 0 ? 0 : first);
  } catch (e) {
    if (job !== S.loading) return;
    console.error(e);
    const limit = /limit exceeded/i.test(e.message || '');
    status(limit
      ? '数据加载失败：Open-Meteo 免费接口本小时的调用次数已用完（按 IP 计）。<br><small>请稍后再试；30 分钟内看过的地点会直接用缓存。</small>'
      : `数据加载失败：${esc(e.message || e)}<br><small>可能是网络或数据服务暂时不可用。</small>`, { err: true, busy: false });
  }
}

function writeHash() {
  const s = S.site;
  history.replaceState(null, '', `#${s.lat.toFixed(4)},${s.lon.toFixed(4)},${Math.round(s.zObs)},${encodeURIComponent(s.name)}`);
}
function readHash() {
  const p = decodeURIComponent(location.hash.slice(1)).split(',');
  if (p.length < 2 || Number.isNaN(+p[0]) || Number.isNaN(+p[1])) return null;
  return { lat: +p[0], lon: +p[1], zObs: p[2] ? +p[2] : null, name: p.slice(3).join(',') || `${(+p[0]).toFixed(3)}, ${(+p[1]).toFixed(3)}` };
}

// ---------- 站点卡 ----------
function renderSite() {
  const s = S.site;
  const fc = S.fc;
  const rel = s.zValley != null ? s.zObs - s.zValley : null;
  const warn = [];
  if (s.preset != null && s.dem != null && Math.abs(s.preset - s.dem) > 250) {
    warn.push(`DEM 显示此坐标海拔 ${r0(s.dem)} m，与预置观景点海拔 ${s.preset} m 相差较大，坐标可能不够精确，可拖动橙色标记微调。`);
  }
  if (rel != null && rel < 250) warn.push('观测点与周边谷底高差不足 250 m，更可能身处云雾中而非俯瞰云海。');
  $('#site').innerHTML = `
    <h2>${esc(s.name)}</h2>
    <div class="sub">${s.lat.toFixed(4)}°N, ${s.lon.toFixed(4)}°E${fc ? ` · 时区 ${esc(fc.tz)}` : ''}</div>
    <div class="kv">
      <div>观测海拔<b>${r0(s.zObs, ' m')}</b></div>
      <div>DEM 海拔<b>${r0(s.dem, ' m')}</b></div>
      <div>周边谷底<b>${r0(s.zValley, ' m')}</b></div>
      <div>相对高差<b>${r0(rel, ' m')}</b></div>
      <div>模式格点<b>${fc ? r0(fc.gridElevation, ' m') : '—'}</b></div>
      <div>可用模式<b>${S.res ? `${S.res.models.length} / ${MODELS.length}` : '—'}</b></div>
    </div>
    ${warn.map((w) => `<div class="warnline">⚠ ${w}</div>`).join('')}`;
}

// ---------- 7 天卡片 ----------
function renderDays() {
  $('#days').innerHTML = S.res.days.map((d, k) => {
    const L = dayLabel(d.key);
    const rd = relDay(d.key);
    const mn = d.sea.min ?? 0;
    const mx = d.sea.max ?? 0;
    return `<button class="day${d.past ? ' past' : ''}" data-k="${k}" aria-pressed="${k === S.day}">
      <div class="d">${rd ?? L.w}<small>${L.md}</small></div>
      <div class="sea" title="${esc(dailyDataNote(d))}">
        <div class="lbl"><span>云海 · 日出 ${hm(d.rise.time)}</span><b>${scoreText(d.sea.mean)}${d.sea.mean == null ? '' : '/100'}</b></div>
        <div class="meter" title="条件指数模式范围 ${r0(mn)}–${r0(mx)} /100"><span class="rng" style="left:${mn}%;width:${mx - mn}%"></span><span class="val" style="width:${d.sea.mean ?? 0}%"></span></div>
        <small>低云量 ${r0(d.lowCloud.mean, '%')}（${d.lowCloud.n} 模式） · 指数有效 ${d.sea.n}/${Object.keys(d.models).length}${d.bestIdx == null ? '' : ` · ${hm(S.res.hours[d.bestIdx].t)}`}</small>
      </div>
      <div class="m">日出<b class="sun">${scoreText(d.vis.mean)}${d.vis.mean == null ? '' : '/100'}</b></div>
      <div class="m">朝霞<b>${r0(d.glow.mean)}</b></div>
    </button>`;
  }).join('');
  $('#days').querySelectorAll('.day').forEach((b) => b.addEventListener('click', () => selectDay(+b.dataset.k)));
}

// ---------- 选中某天 ----------
function selectDay(k) {
  S.day = k;
  const d = S.res.days[k];
  renderDays();
  renderDetail(d);
  renderModelTable(d);
  renderCsDay(d);
  drawHorizonFor(d);
  setHour(d.riseIdx, { fromDay: true });
}

function rayFor(d) {
  const per = Object.values(d.models).map((m) => m.sun.per);
  const xs = [...new Set(per.flat().map((p) => p.x))].sort((a, b) => a - b);
  return xs.map((x) => {
    const ts = per.map((arr) => arr.find((p) => p.x === x)?.t).filter((t) => t != null);
    return { x, t: ts.length ? ts.reduce((a, b) => a + b, 0) / ts.length : null };
  });
}

function drawHorizonFor(d) {
  if (!S.terrain?.length) { $('#horizon-meta').textContent = '地形剖面不可用'; return; }
  drawHorizon(d, S.site, S.terrain, S.model);
  const g = d.geo;
  $('#horizon-meta').textContent = `${modelName(S.model)} · 视地平 ${g.alpha.toFixed(2)}°（眼高差 −${g.dip.toFixed(2)}°${g.blocked ? `，地形遮挡 ${g.terrainAngle.toFixed(2)}°` : ''}）`;
  M.setRay(S.site, d.rise.azimuth, rayFor(d));
}

// ---------- 详情 ----------
function level(p) {
  if (p == null) return { cls: 'lo', txt: '无数据' };
  if (p >= 60) return { cls: 'hi', txt: '较有利' };
  if (p >= 35) return { cls: 'mid', txt: '一般' };
  if (p >= 15) return { cls: 'lo', txt: '偏不利' };
  return { cls: 'lo', txt: '不利' };
}
function confidence(st) {
  if (st.n < 2 || st.sd == null) return '单模式 · 未验证';
  if (st.sd < 10) return '模式判断较一致 · 未校准';
  if (st.sd < 20) return '模式存在一定分歧 · 未校准';
  return '模式分歧明显 · 未校准';
}

function reasons(d) {
  const s = S.site;
  const out = [];
  const zt = d.ztop.mean;
  if (d.type === 'A') out.push(`<b>层积云型</b>：多数模式在低层诊断出饱和层（RH≥92% 或云量≥70%），云顶约 <b>${r0(zt)} m</b>。`);
  else if (d.type === 'B') out.push(`<b>辐射雾 / 谷雾型</b>：夜间晴空弱风、谷底接近饱和，雾顶约 <b>${r0(zt)} m</b>，通常日出后 1–2 小时消散。`);
  else if (!d.sea.n) out.push('有效评分不足，<b>不能判断是否存在可俯瞰云海</b>；请查看低云量及各模式诊断原因。');
  else if ((d.lowCloud?.mean ?? 0) > 5) out.push(`数值模式日出时刻仍预报低云量约 <b>${r0(d.lowCloud.mean, '%')}</b>，但稀疏气压层没有解析出可靠云顶；<b>不能据此判定没有云海</b>。`);
  else out.push('部分模式的气压层未诊断出明显低云且地面低云量较低；这不排除未解析的局地谷雾。');
  const hasSea = d.type !== 'none' && d.ztop.mean != null;
  if (zt != null && hasSea) {
    const m = s.zObs - zt;
    if (m >= 200) out.push(`云顶低于观测点约 <b>${r0(m)} m</b>，站位可俯瞰云面。`);
    else if (m >= 0) out.push(`云顶仅低于观测点 <b>${r0(m)} m</b>，云面可能贴近甚至漫上山顶。`);
    else out.push(`云顶高于观测点约 <b>${r0(-m)} m</b>，你很可能<b>身处云中</b>，看不到云海。`);
  }
  if (d.cap.mean != null) {
    const c = d.cap.mean;
    if (!hasSea) out.push(`低层位温梯度 <b>${r1(c)} K/km</b>：${c >= 4 ? '有逆温，但缺少足够的水汽成云' : '层结偏弱，低层空气混合较强'}。`);
    else out.push(`云顶附近位温梯度 <b>${r1(c)} K/km</b>：${c >= 8 ? '强逆温封盖，云面平整稳定' : c >= 4 ? '有一定逆温，云面较稳定' : '封盖弱，云顶易起伏或消散'}。`);
  }
  if (d.afterRain) out.push('过去 24 小时有降水且日出时转停，<b>雨后放晴</b>常是云海最佳窗口。');
  const pr = d.hike.precip.mean;
  if (pr != null && pr >= 0.2) out.push(`日出时段预报有降水（约 ${r1(pr)} mm/h），不利于观景。`);
  const g = d.geo;
  if (g.blocked) {
    const late = (g.actual.time - g.summit.time) / 60e3;
    out.push(`东侧 ${r0(g.terrainAt?.x / 1000)} km 处地形高于视地平（仰角 ${g.terrainAngle.toFixed(2)}°），太阳露出约<b>推迟 ${r0(late)} 分钟</b>。`);
  }
  const vis = d.vis.mean;
  if (vis != null) {
    if (S.horizonOk === false) out.push('远方云量数据获取失败，日出遮云条件暂不可判定。');
    else if (vis >= 60) out.push(`日出方向 300 km 光路上云层稀薄，<b>日出观测条件较有利（未经校准）</b>。`);
    else if (vis >= 30) out.push('日出方向光路上有部分云层，太阳可能从云缝中露出。');
    else out.push('日出方向光路上云层较厚或身处云中，<b>日出可能被遮挡</b>。');
  }
  const aod = d.air.aod;
  if (aod != null) out.push(`气溶胶光学厚度 AOD ${aod.toFixed(2)}：${aod < 0.1 ? '空气极通透，天色偏冷' : aod < 0.4 ? '适量气溶胶，利于暖色朝霞' : aod < 0.8 ? '偏浑浊，太阳初升时偏暗' : '霾/沙尘较重，日出发白发暗'}。`);
  return out;
}

function hikeAlerts(d) {
  const s = S.site;
  const h = d.hike;
  const a = [];
  if (h.T.n === 0 || h.ws.n === 0 || h.gust.n === 0 || h.precip.n === 0) {
    a.push('气温、风、阵风或降水资料不完整，不能据此判定登山气象风险低。');
  }
  if (h.feels.min != null && h.feels.min <= -10) a.push(`体感温度低至 ${r0(h.feels.min)}°C，注意防寒，手指与面部易冻伤。`);
  else if (h.feels.min != null && h.feels.min <= 0) a.push(`体感温度约 ${r0(h.feels.mean)}°C，需要保暖外套、手套与帽子。`);
  if (h.gust.max != null && h.gust.max >= 17) a.push(`阵风可达 ${r0(h.gust.max)} m/s（${Math.round(h.gust.max * 3.6)} km/h），山脊行走危险。`);
  else if (h.ws.max != null && h.ws.max >= 10) a.push(`观测高度风速约 ${r0(h.ws.mean)} m/s，体感会明显偏冷。`);
  if (h.frz.mean != null && h.frz.mean < s.zObs + 100 && (h.T.mean ?? 9) < 2) a.push(`零度层约 ${r0(h.frz.mean)} m，低于或接近山顶，台阶与岩面可能结冰。`);
  if (h.precip.max != null && h.precip.max >= 0.5) a.push('日出时段可能有降水，携带雨具，注意湿滑。');
  if (d.sea.mean != null && d.ztop.mean != null && d.ztop.mean > s.zObs - 50) a.push('云顶接近或高于观测点，能见度可能很低，注意迷路风险。');
  if (!a.length) a.push('未发现明显的气象风险，仍请关注官方预警与景区开放信息。');
  return a;
}

function renderDetail(d) {
  const L = dayLabel(d.key);
  const lv = level(d.sea.mean);
  const lvSun = level(d.vis.mean);
  const civil = findRise(d.rise.time - 3 * 3600e3, d.rise.time, S.site.lat, S.site.lon, -6);
  const arrive = d.rise.time - 40 * 60e3;
  const fNames = { cloud: '成云条件', height: '高度裕度', cap: '逆温封盖', dry: '上空通透', wind: '风力适宜', precip: '无降水' };
  const alerts = hikeAlerts(d);
  const ok = alerts.length === 1 && alerts[0].startsWith('未发现');
  $('#detail').innerHTML = `
    <h3>${relDay(d.key) ? `${relDay(d.key)} · ` : ''}${L.md} ${L.w} · 日出 ${hm(d.rise.time)}</h3>
    <div class="verdict">
      <span class="tag ${lv.cls}">云海条件${lv.txt}</span><span class="tag ${lvSun.cls === 'hi' ? 'hi' : lvSun.cls}">日出条件${lvSun.txt}</span><span class="tag conf">${confidence(d.sea)}</span>
    </div>
    <div class="trio">
      <div><small>云海条件指数</small><b>${scoreText(d.sea.mean)}</b><span>${d.sea.mean == null ? '无法计算' : `/100 · ${r0(d.sea.min)}–${r0(d.sea.max)}`}</span></div>
      <div><small>日出可见条件指数</small><b class="sun">${r0(d.vis.mean)}</b><span>/100 · ${r0(d.vis.min)}–${r0(d.vis.max)}</span></div>
      <div><small>朝霞指数</small><b>${r0(d.glow.mean)}</b><span>/ 100</span></div>
    </div>
    <p class="data-diagnostics"><b>日出低云量（模式格点）${r0(d.lowCloud.mean, '%')}</b> · 近地 RH ${r0(d.nearSurfaceRH.mean, '%')} · ${esc(dailyDataNote(d))}${d.ztop.n ? ` · 云顶范围 ${r0(d.ztop.min)}–${r0(d.ztop.max)} m（${d.ztop.n} 个模式）` : ''}。<br>0 表示规则评分不利；— 表示缺测或云顶无法解析。低云量是网格覆盖率，并非山顶云海出现概率。</p>
    <details class="score-explain"><summary>查看评分公式与每个天气模式的计算依据</summary>
      <p>云海条件指数 S = 100 × 成云因子 × 高度因子 × Q；Q = 封盖因子<sup>0.35</sup> × 上空通透因子<sup>0.30</sup> × 风速因子<sup>0.15</sup> × 无降水因子<sup>0.20</sup>。这些权重未经实况校准，不是概率。</p>
      <div class="score-mode-list">${Object.entries(d.models).map(([id, m]) => { const v = m.seaAtBest; return `<div><b>${esc(modelName(id))}</b><span>${d.bestIdx == null ? '云海评分' : '最佳时刻指数'} ${scoreText(v?.P)}${v?.P == null ? '' : '/100'}</span><small>日出低云量 ${r0(m.lowCloud, '%')} · 近地 RH ${r0(m.nearSurfaceRH, '%')} · 有效气压层 ${m.pressureLevelCount ?? 0} 层。${esc(diagnosticLabel(v))}</small></div>`; }).join('')}</div>
    </details>
    <ul class="why">${reasons(d).map((x) => `<li>${x}</li>`).join('')}</ul>
    <div>
      <p class="subh">云海因子（集合平均，1 为最有利）</p>
      <div class="factors">${Object.entries(fNames).map(([k, n]) => {
        const v = d.factors[k]?.mean;
        return `<div class="factor"><span>${n}</span><div class="meter"><span class="val" style="width:${(v ?? 0) * 100}%"></span></div><span class="v">${v == null ? '—' : v.toFixed(2)}</span></div>`;
      }).join('')}</div>
    </div>
    <div>
      <p class="subh">日出几何</p>
      <div class="grid2">
        <div><span>民用晨光始</span>${hm(civil?.time)}</div>
        <div><span>日出方位</span>${d.rise.azimuth.toFixed(1)}°</div>
        <div><span>海平面日出</span>${hm(d.geo.sea?.time)}</div>
        <div><span>山顶日出</span>${hm(d.geo.summit?.time)}</div>
        <div><span>地形修正日出</span>${hm(d.geo.actual?.time)}</div>
        <div><span>眼高差</span>−${d.geo.dip.toFixed(2)}°</div>
        <div><span>预测云顶</span>${r0(d.ztop.mean, ' m')}</div>
        <div><span>AOD / PM2.5</span>${d.air.aod == null ? '—' : d.air.aod.toFixed(2)} / ${r0(d.air.pm25)}</div>
      </div>
    </div>
    <div>
      <p class="subh">登顶建议（日出时刻，观测高度）</p>
      <div class="grid2">
        <div><span>建议到达</span><b>${hm(arrive)}</b></div>
        <div><span>气温</span>${r1(d.hike.T.mean, '°C')}</div>
        <div><span>体感</span>${r1(d.hike.feels.mean, '°C')}</div>
        <div><span>风速 / 阵风</span>${r0(d.hike.ws.mean)} / ${r0(d.hike.gust.max)} m/s</div>
        <div><span>零度层</span>${r0(d.hike.frz.mean, ' m')}</div>
        <div><span>最佳云海时刻</span>${d.bestIdx == null ? '—' : hm(S.res.hours[d.bestIdx].t)}</div>
      </div>
      <ul class="alerts" style="margin-top:8px">${alerts.map((x) => `<li class="${ok ? 'ok' : ''}">${x}</li>`).join('')}</ul>
    </div>`;
}

// ---------- 模式表 ----------
const TYPE = { A: '层积云', B: '辐射雾', none: '—' };
function renderModelTable(d) {
  const rows = S.res.models.map((id) => {
    const m = d.models[id];
    const a = m.seaAtBest ?? {};
    return `<tr><td><span class="dot" style="background:${modelColor(id)}"></span>${modelName(id)}</td>
      <td>${r0(m.sea, '/100')}</td><td>${r0(m.lowCloud, '%')}</td><td>${r0(a.ztop, ' m')}</td><td>${TYPE[a.type] ?? '—'}</td><td>${r1(a.cap)}</td><td>${r0(a.rhObs, '%')}</td>
      <td>${r0(m.sun.Pvis, '/100')}</td><td>${r0(m.sun.glow)}</td><td>${r0(m.sun.canvas, '%')}</td><td>${r1(m.hike.T, '°')}</td><td>${r1(m.hike.ws)}</td></tr>`;
  }).join('');
  $('#model-table').innerHTML = `<table>
    <thead><tr><th>模式</th><th>云海指数</th><th>模式低云量</th><th>云顶</th><th>类型</th><th>封盖 K/km</th><th>山顶 RH</th><th>日出可见条件指数</th><th>朝霞</th><th>中高云</th><th>气温</th><th>风 m/s</th></tr></thead>
    <tbody>${rows}<tr class="mean"><td>集合平均</td><td>${r0(d.sea.mean, '/100')}</td><td>${r0(d.lowCloud.mean, '%')}</td><td>${r0(d.ztop.mean, ' m')}</td><td>${TYPE[d.type]}</td><td>${r1(d.cap.mean)}</td><td>—</td>
      <td>${r0(d.vis.mean, '/100')}</td><td>${r0(d.glow.mean)}</td><td>—</td><td>${r1(d.hike.T.mean, '°')}</td><td>${r1(d.hike.ws.mean)}</td></tr></tbody></table>`;
}

function renderModelSelect() {
  $('#profile-model').innerHTML = S.res.models.map((id) => `<option value="${id}"${id === S.model ? ' selected' : ''}>${modelName(id)}</option>`).join('');
}

// ---------- 逐小时 ----------
function hourRange() {
  const H = S.res.hours;
  let lo = H.findIndex((h) => h.t >= Date.now() - 30 * 3600e3);
  if (lo < 0) lo = 0;
  return [lo, H.length - 1];
}

function setHour(i, { fromDay = false } = {}) {
  const H = S.res.hours;
  i = Math.max(0, Math.min(H.length - 1, i));
  S.hour = i;
  const h = H[i];
  const [lo, hi] = hourRange();
  const sl = $('#hour');
  sl.min = lo; sl.max = hi; sl.value = i;
  const L = dayLabel(h.local.slice(0, 10));
  const P = h.P.mean;
  const zt = h.ztop.mean;
  $('#hour-label').innerHTML = `<b>${L.md} ${h.local.slice(11, 16)}</b> · 太阳 ${h.sunEl.toFixed(0)}° · 云海指数 <b>${r0(P, '/100')}</b>${zt != null ? ` · 诊断云顶 ${r0(zt, ' m')}` : ' · 云顶无法判断'}`;
  // Cloud existence is independent of the viewpoint's suitability score.
  const show = zt != null;
  const tint = h.sunEl < -6 ? 'night' : h.sunEl < 10 ? 'dawn' : 'day';
  const a = agg(i);
  renderLiveDiagnostic(h, a);
  const cover = a.cl.mean == null ? 0.25 : Math.min(1, 0.25 + a.cl.mean / 120);
  M.setCloudTop(show ? zt : null, tint, { P: P ?? 0, cover, center: S.site, sunAz: S.res.days[S.day]?.rise.azimuth });
  renderLegend(h, show);
  drawProfile(h, S.site, S.model);
  drawTimeline(S.res, S.fc.offset, { selected: i, nowMs: Date.now(), onSelect: onTimelinePick });
  renderCsHour(i);
  if (!fromDay) {
    const k = S.res.days.findIndex((d) => d.key === h.local.slice(0, 10));
    if (k >= 0 && k !== S.day) {
      S.day = k;
      const d = S.res.days[k];
      renderDays(); renderDetail(d); renderModelTable(d); renderCsDay(d); drawHorizonFor(d);
    }
  }
}

function onTimelinePick(i) { stopPlay(); setHour(i); }

// Map-first current-hour diagnosis: weather inputs are not observations of a continuous cloud field.
function renderLiveDiagnostic(h, a) {
  const el = $('#live-diagnostic');
  if (!el) return;
  const nTotal = S.res.models.length;
  const nScore = h.P.n;
  const nTop = h.ztop.n;
  const top = h.ztop.mean;
  const delta = top == null ? null : S.site.zObs - top;
  const sky = top == null ? (h.P.mean === 0 ? '当前条件不利，未诊断出稳定低云顶' : '云顶数据不足或无法判定')
    : delta < 0 ? '观测点可能处于云中'
      : delta < 150 ? '云顶贴近观测点'
        : '可俯瞰诊断云层';
  const diagnoses = Object.values(h.models).map((m) => m.diagnosis);
  const missing = diagnoses.filter((v) => v === 'missing-input' || v === 'insufficient-profile').length;
  const unresolved = diagnoses.filter((v) => v === 'unresolved-cloud-top').length;
  const quality = nScore === 0 ? (unresolved ? '浅层低云或云顶无法判定' : '关键气象资料不足')
    : nScore < nTotal ? `部分模式无法评分（云顶未解 ${unresolved} · 缺测 ${missing}）`
      : '有效模式已完成评分';
  const cloudText = nTop === 0 ? (h.P.mean === 0 ? '未检出' : '无法判断') : `${r0(top)} m <small>(${nTop}/${nTotal} 模式)</small>`;
  el.innerHTML = `<div class="ld-head"><b>逐小时诊断</b><span>${h.local.slice(5, 16).replace('T', ' ')}</span></div>
    <div class="ld-main"><div><small>云海条件指数（非概率）</small><strong>${scoreText(h.P.mean)}<em>${h.P.mean == null ? '未计算' : '/100'}</em></strong></div>
    <div><small>云顶估计</small><strong class="ld-top">${cloudText}</strong></div></div>
    <div class="ld-status">${sky} · 低云量 ${r0(a.cl.mean, '%')}（${a.cl.n} 模式）</div>
    <div class="ld-meta"><span>${quality}</span><span>有效评分 ${nScore}/${nTotal}</span></div>
    <p>${h.P.mean === 0 ? '0 是计算条件指数，不代表出现云海的真实概率为 0%。' : h.P.mean == null ? '缺少可计算的云顶或输入数据；不以零代替。' : '3D 云面为示意，不是实际云区覆盖范围。'} 请结合现场观测与官方气象预警。</p>`;
}

// ---------- 云海详细预报 ----------
function renderCsDay(d) {
  $('#cs-summary').innerHTML = `<h5 class="cs-day">${relDay(d.key) ? `${relDay(d.key)} · ` : ''}${dayLabel(d.key).md} ${dayLabel(d.key).w}</h5>${CS.summaryHtml(S.res, S.fc, S.site, d, hm)}`;
  $('#cs-day-lbl').textContent = `${dayLabel(d.key).md}（含前一晚 21–23 时），集合平均；“主要限制”为 6 个云海因子中最不利的一项`;
}

function renderCsHour(i) {
  const d = S.res.days[S.day];
  $('#cs-heat').innerHTML = CS.heatmapHtml(S.res, S.res.days, { selected: i, dayLabel, relDay });
  $('#cs-hours').innerHTML = CS.hourTableHtml(S.res, S.fc, S.site, d, i);
  drawCloudLayer(S.res, S.site, S.fc.offset, { selected: i, nowMs: Date.now(), onSelect: onTimelinePick, agg });
  renderCsNow();
  renderCsSpots();
}

function renderCsNow() {
  const i = S.hour;
  const a = agg(i);
  const s = S.site;
  const p = a.P.mean;
  const has = a.ztop.mean != null;
  const rel = has ? s.zObs - a.ztop.mean : null;
  const cov = has ? CS.coverage(S.grid, a.ztop.mean) : null;
  const L = dayLabel(a.local.slice(0, 10));
  const lv = level(p);
  const thick = has && a.zbase.mean != null ? a.ztop.mean - a.zbase.mean : null;
  $('#cs-now').innerHTML = `<h5>${L.md} ${a.local.slice(11, 16)} · 太阳高度 ${r0(a.sunEl, '°')}</h5>
    <div class="big">
      <span><b>${r0(p)}</b><small>/100 云海条件指数 · ${lv.txt}</small></span>
      <span><b>${has ? r0(a.ztop.mean) : '—'}</b><small>m 云顶${has ? ` · ${r0(a.ztop.min)}–${r0(a.ztop.max)}` : ''}</small></span>
      <span><b>${cov == null ? '—' : r0(cov * 100)}</b><small>% 地形低于云顶（不代表实际云覆盖）${S.grid ? '' : '（计算中）'}</small></span>
    </div>
    <div class="grid2">
      <div><span>类型</span>${has ? CS.TYPE_TXT[a.type] : '—'}</div>
      <div><span>云底 / 厚度</span>${has ? `${r0(a.zbase.mean, ' m')} / ${r0(thick, ' m')}` : '—'}</div>
      <div><span>观测点相对云顶</span>${rel == null ? '—' : rel >= 0 ? `高 ${r0(rel)} m` : `<span class="bad">低 ${r0(-rel)} m（云中）</span>`}</div>
      <div><span>低云量 / 中云量</span>${r0(a.cl.mean, '%')} / ${r0(a.cm.mean, '%')}</div>
      <div><span>山顶相对湿度</span>${r0(a.rh.mean, '%')}</div>
      <div><span>逆温强度</span>${r1(a.cap.mean, ' K/km')}</div>
      <div><span>山顶风速</span>${r1(a.ws.mean, ' m/s')}</div>
      <div><span>主要限制</span>${p != null && p >= 60 ? '<span class="ok">条件较有利</span>' : a.limit ? a.limit.txt : '—'}</div>
    </div>
    <p class="subh" style="margin-top:10px">各模式</p>
    <div class="cs-models">${Object.entries(a.perModel).map(([id, v]) => `<span><i class="dot" style="background:${modelColor(id)}"></i>${modelName(id)} <b>${r0(v, '/100')}</b></span>`).join('')}</div>`;
}

function renderCsSpots() {
  if (!S.res) return;
  $('#cs-spots').innerHTML = S.spots ? CS.spotsHtml(S.spots, agg(S.hour), S.site) : '<p class="empty">正在读取周边观景点…</p>';
}

function bindCs() {
  $('#cs-heat').addEventListener('click', (e) => { const c = e.target.closest('[data-i]'); if (c) { stopPlay(); setHour(+c.dataset.i); } });
  $('#cs-hours').addEventListener('click', (e) => { const r = e.target.closest('tr[data-i]'); if (r) { stopPlay(); setHour(+r.dataset.i); } });
  $('#cs-spots').addEventListener('click', (e) => {
    const r = e.target.closest('tr[data-lat]');
    if (!r) return;
    $('#spot').value = '';
    loadSite({ name: r.dataset.name, lat: +r.dataset.lat, lon: +r.dataset.lon, preset: +r.dataset.ele });
  });
}

function renderLegend(h, show) {
  const zt = h.ztop;
  $('#legend').innerHTML = show
    ? `<b>云顶高度示意（非实测云海）</b><br><span class="sw" style="background:#f4f6fb"></span>有效模式云顶 ${r0(zt.mean)} m；仅为统一高度的可视化示意，云的水平范围无法由本站廓线确定<br>模式范围 ${r0(zt.min)}–${r0(zt.max)} m（${zt.n} 个模式）<br><span class="sw" style="background:#ffb347;border-radius:50%"></span>日出光路采样点（透光率为启发式估计，非实测）`
    : `<b>此刻云层高度资料不足</b><br>不能据此认定天空无云<br><span class="sw" style="background:#ffb347;border-radius:50%"></span>日出光路采样点（% 为光线透过率）`;
}

function stopPlay() {
  if (S.playTimer) { clearInterval(S.playTimer); S.playTimer = null; $('#play').textContent = '▶'; }
}
function togglePlay() {
  if (S.playTimer) return stopPlay();
  if (!S.res) return;
  $('#play').textContent = '❚❚';
  S.playTimer = setInterval(() => {
    const [lo, hi] = hourRange();
    setHour(S.hour >= hi ? lo : S.hour + 1);
  }, 650);
}

// ---------- 搜索 ----------
let qTimer;
let qItems = [];
let qAbort;
let qActive = 0;
function bindSearch() {
  const q = $('#q');
  const box = $('#q-results');
  const row = (r, i) => {
    const ele = r.ele != null ? ` · ${r.ele} m` : '';
    const d = S.site ? ` · 距观测点 ${fmtDist(distKm(S.site, r))}` : '';
    return `<li data-i="${i}"${i === qActive ? ' aria-selected="true"' : ''}><span class="poi-tag g-${r.group}">${esc(r.kind)}</span>${esc(r.name)}<small>${esc(r.region ?? '')}${ele}${d} · ${esc(r.src)}</small></li>`;
  };
  const render = (items, pending) => {
    qItems = items;
    qActive = Math.min(qActive, Math.max(0, items.length - 1));
    box.innerHTML = (items.length ? items.map(row).join('') : pending ? '' : '<li class="empty">未找到。可试试更短的名称，或直接输入坐标，如 27.46,114.17</li>')
      + (pending ? '<li class="empty">正在检索 OpenStreetMap 附近地点…</li>' : '');
    box.hidden = false;
  };
  const pick = (r) => {
    box.hidden = true;
    if (!r) return;
    $('#spot').value = '';
    $('#q').blur(); // 收起手机键盘
    if (isMobile()) window.scrollTo({ top: 0, behavior: 'smooth' });
    loadSite({ name: r.name, lat: r.lat, lon: r.lon, preset: r.ele ?? null });
  };
  const run = async (v) => {
    qAbort?.abort();
    const ac = new AbortController();
    qAbort = ac;
    qActive = 0;
    const ll = v.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (ll) { render([{ name: `${ll[1]}, ${ll[2]}`, lat: +ll[1], lon: +ll[2], kind: '坐标', group: 'misc', src: '坐标' }]); return; }
    const local = await Q.searchLocal(v);
    if (ac.signal.aborted) return;
    const lists = [local, [], [], [], []];
    const c = M.getMap()?.getCenter();
    const center = c ? { lat: c.lat, lon: c.lng } : S.site;
    const ranked = () => Q.rank(Q.mergeResults(lists), v, center).slice(0, 20);
    render(ranked(), true);
    let failures = 0;
    const jobs = [
      Q.searchOverpass(v, center, ac.signal).then((r) => { lists[1] = r; }),
      Q.searchNominatim(v, ac.signal).then((r) => { lists[2] = r; }),
      Q.searchPlaces(v).then((r) => { lists[3] = r; }),
      Q.searchPhoton(v, ac.signal).then((r) => { lists[4] = r; }),
    ].map((p) => p.catch((err) => {
      failures++;
      console.warn('搜索服务暂不可用', err);
    }).then(() => { if (!ac.signal.aborted) render(ranked(), true); }));
    await Promise.all(jobs);
    if (!ac.signal.aborted) {
      render(ranked(), false);
      if (!ranked().length && failures) {
        box.innerHTML = '<li class="empty">在线地点服务暂不可用或没有匹配结果。可换短关键词、选择预置地点，或输入经纬度定位。</li>';
      }
    }
  };
  q.addEventListener('input', () => {
    clearTimeout(qTimer);
    const v = q.value.trim();
    if (!v) { qAbort?.abort(); box.hidden = true; return; }
    qTimer = setTimeout(() => run(v), 350);
  });
  q.addEventListener('focus', () => { if (q.value.trim() && qItems.length) box.hidden = false; });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!qItems.length) return;
      qActive = (qActive + (e.key === 'ArrowDown' ? 1 : -1) + qItems.length) % qItems.length;
      box.querySelectorAll('li[data-i]').forEach((li) => li.setAttribute('aria-selected', String(+li.dataset.i === qActive)));
      box.querySelector(`li[data-i="${qActive}"]`)?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter') { e.preventDefault(); pick(qItems[qActive]); }
    if (e.key === 'Escape') box.hidden = true;
  });
  box.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) pick(qItems[+li.dataset.i]); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.hidden = true; });
}

function distKm(a, b) {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.hypot(x, y) * 6371;
}
const fmtDist = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);

// ---------- 地图工具 ----------
function bindMapTools() {
  document.querySelectorAll('input[name="base"]').forEach((r) => r.addEventListener('change', () => M.setBase(r.value)));
  $('#lyr-cloud').addEventListener('change', (e) => M.toggleLayer('cloudsea', e.target.checked));
  $('#lyr-contours').addEventListener('change', (e) => M.toggleLayer('contours', e.target.checked));
  $('#lyr-hypso').addEventListener('change', (e) => M.toggleLayer('hypso', e.target.checked));
  $('#lyr-ray').addEventListener('change', (e) => M.toggleLayer('ray', e.target.checked));
  $('#exag').addEventListener('input', (e) => { $('#exag-v').textContent = `${(+e.target.value).toFixed(1)}×`; M.setExaggeration(+e.target.value); });
  $('#view-sunrise').addEventListener('click', () => { const d = S.res?.days[S.day]; if (d) M.sunriseView(S.site, d.rise.azimuth); });
  $('#view-over').addEventListener('click', () => S.site && M.overview(S.site));

  const sat = $('#sat');
  const st = $('#sat-time');
  const op = $('#sat-op');
  const apply = () => M.setSatellite(sat.value, +st.value || undefined, +op.value);
  sat.addEventListener('change', () => {
    if (sat.value === 'himawari') {
      st.innerHTML = M.satelliteTimes(12).map((t) => {
        const d = new Date(t);
        return `<option value="${t}">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</option>`;
      }).join('');
    } else if (sat.value === 'modis') {
      st.innerHTML = [1, 2, 3, 4].map((k) => {
        const t = Date.now() - k * 864e5;
        return `<option value="${t}">${new Date(t).toISOString().slice(0, 10)}</option>`;
      }).join('');
    }
    st.hidden = sat.value === 'none';
    apply();
  });
  st.addEventListener('change', apply);
  op.addEventListener('change', apply);

  $('#play').addEventListener('click', togglePlay);
  const tools = $('.map-tools'), tt = $('#tools-toggle');
  const setTools = (open) => { tools.classList.toggle('collapsed', !open); tt.setAttribute('aria-expanded', String(open)); };
  tt.addEventListener('click', () => setTools(tools.classList.contains('collapsed')));
  if (matchMedia('(max-width: 640px)').matches) setTools(false);
  $('#hour').addEventListener('input', (e) => { stopPlay(); setHour(+e.target.value); });
  $('#profile-model').addEventListener('change', (e) => {
    S.model = e.target.value;
    drawProfile(S.res.hours[S.hour], S.site, S.model);
    drawHorizonFor(S.res.days[S.day]);
  });
}

// 点击地图：弹出确认，避免误触发重新计算
let pickPopup;
function onMapPick({ lat, lon, poi }) {
  pickPopup?.remove();
  const el = document.createElement('div');
  el.className = 'pick';
  const head = poi
    ? `<div style="font-size:13px;font-weight:600;color:#111">${esc(poi.name)}</div><div style="font-size:12px;color:#555;margin-bottom:6px">${esc(poi.kind)}${poi.ele != null ? ` · ${poi.ele} m` : ''} · ${lat.toFixed(4)}, ${lon.toFixed(4)}</div>`
    : `<div style="font-size:12px;color:#333;margin-bottom:6px">${lat.toFixed(4)}, ${lon.toFixed(4)}</div>`;
  el.innerHTML = `${head}<button class="btn sm primary">在此处预测</button>`;
  el.querySelector('button').addEventListener('click', () => {
    pickPopup.remove();
    $('#spot').value = '';
    loadSite(poi ? { name: poi.name, lat, lon, preset: poi.ele ?? null } : { name: `自选点 ${lat.toFixed(3)},${lon.toFixed(3)}`, lat, lon });
  });
  pickPopup = new maplibregl.Popup({ closeButton: true, offset: 8 }).setLngLat([lon, lat]).setDOMContent(el).addTo(M.getMap());
}

// ---------- 观测页 ----------
const SEA_TXT = { 2: '成片云海', 1: '零散', 0: '无', '-1': '身处云中' };
const SUN_TXT = { 2: '完整', 1: '部分', 0: '未见' };

function fillObsDefaults() {
  const f = $('#obs-form');
  if (S.site) f.name.value = S.site.name;
  const d = S.res?.days[S.day];
  f.date.value = d?.key ?? new Date().toISOString().slice(0, 10);
}

function renderObs() {
  const list = O.listObs();
  $('#obs-list').innerHTML = list.length ? `<table>
    <thead><tr><th>日期</th><th>地点</th><th>云海</th><th>日出</th><th>朝霞</th><th>云顶</th><th>当时预测 云海 / 日出</th><th>备注</th><th></th></tr></thead>
    <tbody>${list.map((o) => `<tr><td>${esc(o.date)}</td><td>${esc(o.name)}</td><td>${SEA_TXT[o.sea]}</td><td>${SUN_TXT[o.sun]}</td><td>${r0(o.glow)}</td><td>${r0(o.ztop, ' m')}</td>
      <td>${o.forecast ? `${r0(o.forecast.sea, '/100')} / ${r0(o.forecast.vis, '/100')} <small style="color:var(--text-3)">提前 ${r0(o.forecast.lead)} h</small>` : '<small style="color:var(--text-3)">无快照</small>'}</td>
      <td style="white-space:normal;text-align:left;max-width:240px">${esc(o.note)}</td><td><button class="btn sm" data-del="${esc(o.id)}">删除</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="empty">还没有观测记录。登顶后记下实际看到的云海与日出，就能检验这里的预测准不准。</p>';
  $('#obs-list').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('删除这条观测记录？')) { O.removeObs(b.dataset.del); renderObs(); }
  }));

  const card = (title, v) => {
    if (!v) return `<div><h4>${title}</h4><p class="empty">需要至少 1 条带预测快照的观测。先在“预测”页查看某地，再于当天记录观测。</p></div>`;
    const p = (x) => (x == null ? '—' : x.toFixed(2));
    return `<div><h4>${title} <small>n = ${v.n}</small></h4><div class="grid2">
      <div><span>Brier 评分</span>${v.uncalibrated ? '待概率校准' : p(v.bs)}</div><div><span>技巧评分 BSS</span>${v.uncalibrated ? '待概率校准' : p(v.bss)}</div>
      <div><span>命中率 POD</span>${p(v.pod)}</div><div><span>空报率 FAR</span>${p(v.far)}</div>
      <div><span>CSI</span>${p(v.csi)}</div><div><span>实况发生频率</span>${p(v.base)}</div></div>
      <p class="hint">当前为未经校准的条件指数，不能计算概率型 Brier/BSS。POD/FAR/CSI 仅按指数 50/100 的阈值粗略检验；低样本量结果不可泛化。</p></div>`;
  };
  $('#verify').innerHTML = `<div class="stats">
    ${card('云海条件指数', O.verify(list, 'sea', (o) => (o.sea >= 1 ? 1 : 0)))}
    ${card('日出可见条件指数', O.verify(list, 'vis', (o) => (o.sun >= 1 ? 1 : 0)))}</div>`;
}

function bindObs() {
  const f = $('#obs-form');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const site = S.site ?? { lat: 0, lon: 0 };
    O.addObs({
      siteKey: O.siteKey(site), lat: site.lat, lon: site.lon, zObs: site.zObs,
      name: fd.get('name'), date: fd.get('date'), sea: +fd.get('sea'), sun: +fd.get('sun'),
      glow: +fd.get('glow') || 0, ztop: fd.get('ztop') ? +fd.get('ztop') : null, note: fd.get('note'),
    });
    f.note.value = '';
    f.ztop.value = '';
    renderObs();
  });
  $('#obs-export').addEventListener('click', O.exportObs);
  $('#obs-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { await O.importObs(file); renderObs(); } catch (err) { alert(`导入失败：${err.message}`); }
    e.target.value = '';
  });
}

function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  const obs = name === 'obs';
  $('#tab-forecast').hidden = obs;
  $('#tab-obs').hidden = !obs;
  if (obs) { stopPlay(); fillObsDefaults(); renderObs(); } else M.getMap()?.resize();
  window.scrollTo({ top: 0 });
}

export function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.hidden = true; }, ms);
}

function openDocs() {
  const sheet = $('#docs-sheet');
  const fr = sheet.querySelector('iframe');
  // 单文件版把文档内嵌为 window.__DOCS__；常规部署直接加载 docs.html
  if (window.__DOCS__) { if (!fr.srcdoc) fr.srcdoc = window.__DOCS__; } else if (!fr.src) fr.src = 'docs.html';
  sheet.hidden = false;
  document.body.classList.add('noscroll');
}

async function share() {
  const s = S.site;
  const d = S.res?.days[S.day];
  const title = `云海·日出预报｜${s?.name ?? ''}`;
  const text = d ? `${s.name} ${d.key} 日出 ${hm(d.rise.time)}：云海条件指数 ${r0(d.sea.mean, '/100')}、日出可见条件指数 ${r0(d.vis.mean, '/100')}、朝霞指数 ${r0(d.glow.mean, '/100')}（未经概率校准）` : title;
  const url = /^https?:/.test(location.protocol) ? location.href : null;
  try {
    if (navigator.share) { await navigator.share(url ? { title, text, url } : { title, text }); return; }
    await navigator.clipboard.writeText(url ? `${text}\n${url}` : text);
    toast(url ? '链接已复制，可直接粘贴分享' : '预报摘要已复制；单文件版请直接把 HTML 文件发给朋友');
  } catch (e) {
    if (e?.name !== 'AbortError') toast('无法调用系统分享，请手动复制地址栏链接');
  }
}

function bindTabs() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#docs-link').addEventListener('click', (e) => { e.preventDefault(); openDocs(); });
  $('#docs-sheet [data-close]').addEventListener('click', () => { $('#docs-sheet').hidden = true; document.body.classList.remove('noscroll'); });
  document.querySelector('.mnav').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'docs') openDocs();
    if (b.dataset.act === 'share') share();
    if (b.dataset.go) {
      showTab('forecast');
      requestAnimationFrame(() => $('#' + b.dataset.go).scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  });
  // 手机上点热力图 / 逐时表 / 7 天卡片后，地图在屏幕外：给一个回到地图的提示
  for (const sel of ['#cs-heat', '#cs-hours', '#days']) {
    $(sel).addEventListener('click', (e) => {
      if (!isMobile() || !e.target.closest('[data-i],[data-k],.day')) return;
      if ($('.map-wrap').getBoundingClientRect().bottom < 80) toast('已切换时刻 · 点顶部“⛰ 预测”回到 3D 地图');
    });
  }
}

const isMobile = () => matchMedia('(max-width: 640px)').matches;

function gestureTip() {
  const tip = $('#gesture-tip');
  if (!matchMedia('(pointer: coarse)').matches) return;
  document.documentElement.classList.add('touch');
  try { if (localStorage.getItem('yh-tip')) return; } catch { /* 隐私模式 */ }
  tip.hidden = false;
  const close = () => { tip.hidden = true; try { localStorage.setItem('yh-tip', '1'); } catch { /* 忽略 */ } };
  tip.querySelector('button').addEventListener('click', close);
  setTimeout(close, 9000);
}

// ---------- 初始化 ----------
function init() {
  const sel = $('#spot');
  sel.innerHTML = '<option value="">预置观景点…</option>'
    + SPOTS.map((s) => `<option value="${s.id}">${s.name}（${s.region} ${s.elevation} m）</option>`).join('');
  sel.addEventListener('change', () => {
    const s = SPOTS.find((x) => x.id === sel.value);
    if (s) loadSite({ name: s.name, lat: s.lat, lon: s.lon, preset: s.elevation });
  });

  const fromHash = readHash();
  const start = fromHash ?? (() => { const s = SPOTS[0]; return { name: s.name, lat: s.lat, lon: s.lon, preset: s.elevation }; })();
  if (!fromHash) sel.value = SPOTS[0].id;

  M.initMap($('#map'), { center: start, onPick: onMapPick });
  M.addSpots(SPOTS, (s) => { sel.value = s.id; loadSite({ name: s.name, lat: s.lat, lon: s.lon, preset: s.elevation }); });
  M.onPoiPick((p) => onMapPick({ lat: p.lat, lon: p.lon, poi: p }));
  Q.loadPois().then((list) => M.setPois(list));
  M.onMarkerDrag(({ lat, lon }) => { sel.value = ''; loadSite({ name: `自选点 ${lat.toFixed(3)},${lon.toFixed(3)}`, lat, lon }, { fly: false }); });

  $('#reload').addEventListener('click', () => {
    if (!S.site) return;
    const z = +$('#alt').value;
    loadSite({ ...S.site, zObs: Number.isFinite(z) && $('#alt').value !== '' ? z : null }, { fly: false });
  });
  $('#alt').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#reload').click(); });

  bindSearch();
  bindMapTools();
  bindObs();
  bindTabs();
  bindCs();
  gestureTip();
  renderLegend({ ztop: {} }, false);
  loadSite(start);
}

init();
