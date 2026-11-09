// 地点搜索：离线 OSM 地点包（预置山区）+ Overpass 周边实时检索 + Nominatim + Open-Meteo 地名库
import { SPOTS } from './spots.js';
import { geocode } from './data.js';

const GROUP = {
  '客栈/山屋': 'stay', 客栈: 'stay', 酒店: 'stay', 青旅: 'stay', 山屋: 'stay', 营地: 'stay', 避难所: 'stay',
  山峰: 'peak', 垭口: 'peak', 山脊: 'peak', 崖: 'peak', 奇石: 'peak',
  观景台: 'view', 景点: 'view', 瀑布: 'view', 古迹: 'view', 寺庙: 'view', 洞: 'view',
  索道站: 'lift', 索道: 'lift', 登山口: 'lift', 车站: 'lift', 停车场: 'lift',
  餐饮: 'food', 商店: 'food', 饮水: 'food', 泉: 'food',
  镇: 'place', 村: 'place', 地名: 'place',
};
export const groupOf = (kind) => GROUP[kind] ?? 'misc';

// 区域别名：武功山金顶 → 武功山，用于“武功山武发客栈”这类带山名前缀的查询
const SUFFIX = /(金顶|光明顶|玉皇顶|主峰|南峰|红云金顶|汉阳峰|祝融峰|歪桃峰|拔仙台)$/;
const regionAlias = (name) => name.replace(SUFFIX, '') || name;

let poiCache;
export async function loadPois() {
  if (poiCache) return poiCache;
  try {
    // 单文件版把地点包内嵌为 window.__POIS__
    const d = window.__POIS__ ?? await (await fetch('data/pois.json')).json();
    poiCache = [];
    for (const [id, reg] of Object.entries(d)) {
      const region = regionAlias(reg.name);
      for (const [name, lat, lon, kind, ele] of reg.pois) {
        poiCache.push({ name, lat, lon, kind, ele, region, regionId: id, group: groupOf(kind), src: 'OSM' });
      }
    }
  } catch (e) {
    console.warn('离线地点包加载失败', e);
    poiCache = [];
  }
  return poiCache;
}

const norm = (s) => s.toLowerCase().replace(/[\s·・\-_()（）]/g, '');

function score(item, q, qNoRegion) {
  const n = norm(item.name);
  let s = 0;
  if (n === q) s = 100;
  else if (n.startsWith(q)) s = 80;
  else if (n.includes(q)) s = 60;
  else if (qNoRegion && (n === qNoRegion || n.includes(qNoRegion))) s = n === qNoRegion ? 90 : 70;
  else if (q.length >= 3 && norm(item.region + item.name).includes(q)) s = 50;
  if (!s) return 0;
  if (item.group === 'stay' || item.group === 'peak' || item.group === 'view') s += 5;
  return s - n.length * 0.1;
}

export async function searchLocal(raw, limit = 60) {
  const q = norm(raw);
  if (!q) return [];
  const pois = await loadPois();
  const aliases = [...new Set(SPOTS.map((s) => norm(regionAlias(s.name))))];
  const prefix = aliases.find((a) => q.startsWith(a) && q.length > a.length);
  const qNoRegion = prefix ? q.slice(prefix.length) : null;
  const spotHits = SPOTS.map((s) => ({
    name: s.name, lat: s.lat, lon: s.lon, ele: s.elevation, kind: '预置观景点', group: 'peak', region: s.region, src: '预置',
    _s: norm(s.name).includes(q) || norm(s.region + s.name).includes(q) ? 120 : 0,
  })).filter((s) => s._s);
  const hits = [];
  for (const p of pois) {
    if (prefix && qNoRegion && norm(p.region) !== prefix) continue;
    const s = score(p, q, qNoRegion);
    if (s) hits.push({ ...p, _s: s });
  }
  return [...spotHits, ...hits].sort((a, b) => b._s - a._s).slice(0, limit);
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');

// Overpass：当前地图中心 40 km 内名称包含关键词的 OSM 要素
export async function searchOverpass(raw, center, signal) {
  const q = raw.trim();
  if (q.length < 2 || !center) return [];
  const ql = `[out:json][timeout:12];nwr["name"~"${reEsc(q)}",i](around:40000,${center.lat.toFixed(4)},${center.lon.toFixed(4)});out center tags 25;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: ql }), signal });
  if (!r.ok) throw new Error(`Overpass ${r.status}`);
  const d = await r.json();
  return d.elements.map((e) => {
    const t = e.tags ?? {};
    const c = e.center ?? e;
    const kind = kindFromTags(t);
    const ele = parseFloat(t.ele);
    return { name: t['name:zh'] || t.name, lat: c.lat, lon: c.lon, kind, group: groupOf(kind), ele: Number.isFinite(ele) ? Math.round(ele) : null, region: '附近', src: 'OSM' };
  }).filter((p) => p.lat != null && !(p.kind === '道路'));
}

function kindFromTags(t) {
  const m = {
    tourism: { alpine_hut: '客栈/山屋', guest_house: '客栈', hotel: '酒店', hostel: '青旅', chalet: '客栈', camp_site: '营地', viewpoint: '观景台', attraction: '景点', information: '指示/信息' },
    natural: { peak: '山峰', saddle: '垭口', cliff: '崖', spring: '泉', rock: '奇石', ridge: '山脊' },
    aerialway: { station: '索道站' },
    amenity: { restaurant: '餐饮', parking: '停车场', place_of_worship: '寺庙', shelter: '避难所', toilets: '厕所' },
    place: { town: '镇', village: '村', hamlet: '村', locality: '地名' },
  };
  for (const [k, v] of Object.entries(m)) if (t[k] && v[t[k]]) return v[t[k]];
  if (t.highway && !['trailhead', 'bus_stop'].includes(t.highway)) return '道路';
  if (t.highway === 'trailhead') return '登山口';
  if (t.waterway) return '水系';
  return '地点';
}

export async function searchNominatim(raw, signal) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=zh-CN&limit=8&q=${encodeURIComponent(raw)}`, { signal });
  if (!r.ok) throw new Error(`Nominatim ${r.status}`);
  const d = await r.json();
  return d.map((x) => {
    const kind = kindFromTags({ [x.category]: x.type });
    return { name: x.name || x.display_name.split(',')[0], lat: +x.lat, lon: +x.lon, kind, group: groupOf(kind), ele: null,
      region: x.display_name.split(',').slice(1, 4).join('·').trim(), src: 'OSM' };
  }).filter((p) => p.kind !== '道路');
}

export async function searchPlaces(raw) {
  const r = await geocode(raw);
  return r.map((x) => ({ name: x.name, lat: x.lat, lon: x.lon, ele: x.elevation != null ? Math.round(x.elevation) : null, kind: '地名', group: 'place', region: x.admin, src: '地名库' }));
}

// 统一排序：名称相关度为主，距当前位置越近越靠前；名称不相关的远程结果直接丢弃
export function rank(list, raw, here) {
  const q = norm(raw);
  const aliases = [...new Set(SPOTS.map((s) => norm(regionAlias(s.name))))];
  const prefix = aliases.find((a) => q.startsWith(a) && q.length > a.length);
  const qNoRegion = prefix ? q.slice(prefix.length) : null;
  const out = [];
  for (const p of list) {
    let s = p.src === '预置' ? 120 : score({ ...p, region: p.region ?? '' }, q, qNoRegion);
    if (!s && p.src !== '坐标') {
      const n = norm(p.name);
      if (n.length >= 2 && q.includes(n)) s = 40; else continue;
    }
    const km = here ? Math.hypot((p.lat - here.lat) * 111, (p.lon - here.lon) * 111 * Math.cos(here.lat * Math.PI / 180)) : 0;
    out.push({ ...p, _r: s - 8 * Math.log10(1 + km) });
  }
  return out.sort((a, b) => b._r - a._r);
}

// 合并去重（同名且 300 m 内视为同一地点）
export function mergeResults(lists) {
  const out = [];
  for (const list of lists) {
    for (const p of list) {
      const dup = out.find((o) => o.name === p.name && Math.abs(o.lat - p.lat) < 0.003 && Math.abs(o.lon - p.lon) < 0.003);
      if (dup) { if (dup.ele == null && p.ele != null) dup.ele = p.ele; continue; }
      out.push(p);
    }
  }
  return out;
}
