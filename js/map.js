// 3D 地图：MapLibre GL v5 + Mapterhorn DEM（Copernicus GLO-30 等，512px terrarium）+ 等高线 + 云海淹没面 + 日出光路 + 卫星云图 + OSM 地点
/* global maplibregl, mlcontour */
import { destination } from './sun.js';
import { CloudSeaLayer } from './cloudlayer.js';

const DEM_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
const DEM_MAX = 12; // 512px 瓦片，中国区约 20 m/像素
const DEM_ATTR = 'DEM © <a href="https://mapterhorn.com/attribution" target="_blank">Mapterhorn</a> (Copernicus GLO-30)';
let map;
let marker;
let ready;
let orbit;
let rotatedAt = 0; // 旋转拖动结束时刻，用来屏蔽随后的误触 click
const state = { cloudTop: null, tint: 'day', sat: 'none', satTime: null, cloudOn: true, cloud: null };
const cloudLayer = new CloudSeaLayer();

function baseStyle() {
  const sources = {
    esri: {
      type: 'raster', tileSize: 256, maxzoom: 18,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: '影像 © Esri, Maxar, Earthstar Geographics',
    },
    topo: {
      type: 'raster', tileSize: 256, maxzoom: 17,
      tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap',
    },
    terrainSrc: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 512, maxzoom: DEM_MAX, attribution: DEM_ATTR },
    reliefSrc: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 512, maxzoom: DEM_MAX },
    pois: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    ray: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  };
  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources,
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } },
      { id: 'base-esri', type: 'raster', source: 'esri' },
      { id: 'base-topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } },
      {
        id: 'hypso', type: 'color-relief', source: 'reliefSrc', layout: { visibility: 'none' },
        paint: {
          'color-relief-opacity': 0.55,
          'color-relief-color': ['interpolate', ['linear'], ['elevation'],
            0, '#1d6b4f', 500, '#7fae5a', 1000, '#d9cf7a', 1500, '#c99a52', 2000, '#a8693d', 3000, '#8c5a4a', 4000, '#d9d2cf', 5500, '#ffffff'],
        },
      },
      { id: 'hillshade', type: 'hillshade', source: 'reliefSrc', layout: { visibility: 'none' }, paint: { 'hillshade-exaggeration': 0.25, 'hillshade-shadow-color': '#0b1220' } },
      {
        // 仅作图层顺序锚点；真正的云海由 3D 自定义图层 cloudsea-3d 绘制
        id: 'cloudsea', type: 'color-relief', source: 'reliefSrc', layout: { visibility: 'none' },
        paint: { 'color-relief-opacity': 0 },
      },
    ],
    sky: {
      'sky-color': '#7fb2e5', 'horizon-color': '#f2d4b6', 'fog-color': '#dfe7f0',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0.8,
    },
  };
}

export function initMap(el, { center, onPick }) {
  map = new maplibregl.Map({
    container: el, style: baseStyle(), center: [center.lon, center.lat], zoom: 11.5, pitch: 68, bearing: 100,
    maxPitch: 85, attributionControl: { compact: true },
    // 性能：限制像素比、加大瓦片缓存、缩短淡入，CJK 字形本地渲染
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2), maxTileCacheZoomLevels: 6, fadeDuration: 120,
    localIdeographFontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.TerrainControl({ source: 'terrainSrc', exaggeration: 1.3 }), 'top-right');
  orbit = new OrbitControl();
  map.addControl(orbit, 'top-right');
  new TwoFingerGesture(map);
  ready = new Promise((res) => map.on('load', res)).then(() => {
    map.setTerrain({ source: 'terrainSrc', exaggeration: 1.3 });
    addContours();
    map.addLayer({ id: 'ray-line', type: 'line', source: 'ray', filter: ['==', ['get', 'kind'], 'line'],
      paint: { 'line-color': '#ffb347', 'line-width': 3, 'line-dasharray': [2, 1.2], 'line-opacity': 0.95 } });
    map.addLayer({ id: 'ray-pts', type: 'circle', source: 'ray', filter: ['==', ['get', 'kind'], 'pt'],
      paint: {
        'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
        'circle-color': ['interpolate', ['linear'], ['get', 't'], 0, '#5b6577', 0.5, '#f2a65a', 1, '#ffd84d'],
      } });
    map.addLayer({ id: 'ray-lbl', type: 'symbol', source: 'ray', filter: ['==', ['get', 'kind'], 'pt'],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.4] },
      paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.2 } });
    map.addLayer(cloudLayer, 'ray-line');
    addPoiLayers();
  });
  // 手机上默认收起版权信息（点 ⓘ 可展开），避免遮挡地图
  if (matchMedia('(max-width: 640px)').matches) map.once('load', () => el.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  map.on('rotateend', () => { rotatedAt = performance.now(); });
  map.on('pitchend', () => { rotatedAt = performance.now(); });
  map.on('click', (e) => {
    if (e.originalEvent?.target?.closest?.('.spot-marker')) return;
    if (performance.now() - rotatedAt < 400) return;
    if (map.getLayer('poi-dot') && map.queryRenderedFeatures(e.point, { layers: ['poi-dot', 'poi-lbl'] }).length) return;
    onPick?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  });
  return ready;
}

function addContours() {
  try {
    const dem = new mlcontour.DemSource({ url: DEM_URL, encoding: 'terrarium', maxzoom: DEM_MAX, worker: true });
    dem.setupMaplibre(maplibregl);
    map.addSource('contours', {
      type: 'vector', maxzoom: 15,
      tiles: [dem.contourProtocolUrl({
        multiplier: 1, elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours',
        thresholds: { 9: [200, 1000], 11: [100, 500], 12: [50, 250], 13: [50, 250], 14: [20, 100] },
      })],
    });
    map.addLayer({ id: 'contour-lines', type: 'line', source: 'contours', 'source-layer': 'contours',
      paint: { 'line-color': '#fff7d6', 'line-opacity': ['match', ['get', 'level'], 1, 0.7, 0.3], 'line-width': ['match', ['get', 'level'], 1, 1.1, 0.5] } }, 'cloudsea');
    map.addLayer({ id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours', filter: ['>', ['get', 'level'], 0],
      layout: { 'symbol-placement': 'line', 'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'], 'text-font': ['Open Sans Regular'], 'text-size': 10 },
      paint: { 'text-color': '#fff7d6', 'text-halo-color': 'rgba(0,0,0,.7)', 'text-halo-width': 1 } });
  } catch (e) {
    console.warn('等高线插件不可用', e);
  }
}

export async function setSite(site, { fly = true } = {}) {
  await ready;
  if (!marker) {
    const el = document.createElement('div');
    el.className = 'obs-marker';
    el.innerHTML = '<span></span>';
    marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([site.lon, site.lat]).addTo(map);
    marker.on('dragend', () => {
      const p = marker.getLngLat();
      map.fire('obsdrag', { lat: p.lat, lon: p.lng });
    });
  } else marker.setLngLat([site.lon, site.lat]);
  if (fly) map.flyTo({ center: [site.lon, site.lat], zoom: 11.6, pitch: 68, duration: 1800, essential: true });
}

export function onMarkerDrag(cb) {
  ready.then(() => map.on('obsdrag', (e) => cb({ lat: e.lat, lon: e.lon })));
}

export function addSpots(spots, onSelect) {
  ready.then(() => {
    for (const s of spots) {
      const el = document.createElement('button');
      el.className = 'spot-marker';
      el.innerHTML = `<i></i><b>${s.name}</b>`;
      el.title = `${s.name} ${s.elevation} m`;
      el.addEventListener('click', (ev) => { ev.stopPropagation(); onSelect(s); });
      new maplibregl.Marker({ element: el, anchor: 'left' }).setLngLat([s.lon, s.lat]).addTo(map);
    }
  });
}

// 云海：top 云顶海拔(m)，P 概率(%)，cover 0..1 云面连续度，tint 光照（night/dawn/day）
export async function setCloudTop(top, tint = 'day', { P = 50, cover = 0.7, center, sunAz } = {}) {
  await ready;
  state.cloudTop = top;
  state.tint = tint;
  const c = center ?? (marker ? { lat: marker.getLngLat().lat, lon: marker.getLngLat().lng } : null);
  state.cloud = top == null || !c ? null : {
    top, tint, cover, sunAz, lat: c.lat, lon: c.lon, radius: 24000,
    alpha: Math.min(1, 0.45 + P / 80),
  };
  applyCloud();
}

function applyCloud() {
  cloudLayer.set(state.cloud && state.cloudOn ? { ...state.cloud, visible: true } : null);
}

export async function setRay(site, azimuth, samples = []) {
  await ready;
  const end = destination(site.lat, site.lon, azimuth, 300000);
  const feats = [{ type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: lineCoords(site, azimuth) } }];
  for (const s of samples) {
    const [la, lo] = destination(site.lat, site.lon, azimuth, s.x);
    feats.push({ type: 'Feature', properties: { kind: 'pt', t: s.t, label: `${Math.round(s.x / 1000)} km · ${Math.round(s.t * 100)}%` }, geometry: { type: 'Point', coordinates: [lo, la] } });
  }
  map.getSource('ray').setData({ type: 'FeatureCollection', features: feats });
  return end;
}

function lineCoords(site, az) {
  const out = [];
  for (let x = 0; x <= 300000; x += 10000) {
    const [la, lo] = destination(site.lat, site.lon, az, x);
    out.push([lo, la]);
  }
  return out;
}

export async function setBase(kind) {
  await ready;
  map.setLayoutProperty('base-esri', 'visibility', kind === 'esri' ? 'visible' : 'none');
  map.setLayoutProperty('base-topo', 'visibility', kind === 'topo' ? 'visible' : 'none');
  // 卫星影像自带阴影，叠加山体阴影只会多一次贴图渲染
  map.setLayoutProperty('hillshade', 'visibility', kind === 'topo' ? 'visible' : 'none');
}

export async function toggleLayer(id, on) {
  await ready;
  const ids = id === 'contours' ? ['contour-lines', 'contour-labels'] : id === 'ray' ? ['ray-line', 'ray-pts', 'ray-lbl'] : [id];
  if (id === 'cloudsea') { state.cloudOn = on; applyCloud(); return; }
  for (const l of ids) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
}

export async function setExaggeration(x) {
  await ready;
  if (map.getTerrain()) map.setTerrain({ source: 'terrainSrc', exaggeration: x });
}

// 卫星观测：NASA GIBS（向日葵-9 红外 10 分钟一帧 / MODIS 真彩每日）
export function satelliteTimes(hours = 12) {
  const out = [];
  const now = Date.now() - 70 * 60e3;
  const base = Math.floor(now / 600e3) * 600e3;
  for (let k = 0; k < hours * 6; k += 3) out.push(base - k * 600e3);
  return out;
}

export async function setSatellite(kind, timeMs, opacity = 0.65) {
  await ready;
  if (map.getLayer('sat')) map.removeLayer('sat');
  if (map.getSource('sat')) map.removeSource('sat');
  state.sat = kind;
  if (kind === 'none') return;
  let tiles;
  let maxzoom;
  if (kind === 'himawari') {
    const t = new Date(timeMs).toISOString().slice(0, 16) + ':00Z';
    tiles = [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/${t}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`];
    maxzoom = 6;
  } else {
    const d = new Date(timeMs ?? Date.now() - 36 * 3600e3).toISOString().slice(0, 10);
    tiles = [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${d}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`];
    maxzoom = 9;
  }
  map.addSource('sat', { type: 'raster', tiles, tileSize: 256, maxzoom, attribution: 'NASA GIBS / EOSDIS' });
  map.addLayer({ id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-opacity': opacity } }, 'cloudsea');
}

export function sunriseView(site, azimuth) {
  const back = destination(site.lat, site.lon, azimuth + 180, 2500);
  map.flyTo({ center: [back[1], back[0]], bearing: azimuth, pitch: 82, zoom: 12.6, duration: 2200, essential: true });
}

export function overview(site) {
  map.flyTo({ center: [site.lon, site.lat], bearing: 0, pitch: 0, zoom: 9.5, duration: 1500 });
}

// OSM 地点（客栈、山峰、观景台、索道站……）
const POI_COLOR = ['match', ['get', 'g'], 'stay', '#ffb347', 'peak', '#f4f1ea', 'view', '#7fd1ff', 'lift', '#c9a7ff', 'food', '#8fd18a', 'place', '#9aa6b8', '#c7cfdb'];
function addPoiLayers() {
  map.addLayer({ id: 'poi-dot', type: 'circle', source: 'pois', minzoom: 10.5,
    filter: ['!=', ['get', 'g'], 'misc'],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 15, 5], 'circle-color': POI_COLOR,
      'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 } });
  map.addLayer({ id: 'poi-lbl', type: 'symbol', source: 'pois', minzoom: 11.5,
    filter: ['!=', ['get', 'g'], 'misc'],
    layout: {
      'text-field': ['case', ['has', 'ele'], ['concat', ['get', 'name'], '\n', ['to-string', ['get', 'ele']], ' m'], ['get', 'name']],
      'text-font': ['Open Sans Regular'], 'text-size': ['match', ['get', 'g'], 'peak', 12, 'stay', 12, 11],
      'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-max-width': 8,
      'symbol-sort-key': ['match', ['get', 'g'], 'peak', 0, 'stay', 1, 'view', 2, 'lift', 3, 5],
    },
    paint: { 'text-color': POI_COLOR, 'text-halo-color': 'rgba(5,10,20,.85)', 'text-halo-width': 1.4 } });
  map.on('mouseenter', 'poi-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'poi-dot', () => { map.getCanvas().style.cursor = ''; });
  const onPoi = (e) => { const f = e.features?.[0]; if (f) map.fire('poipick', { poi: { ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } }); };
  map.on('click', 'poi-dot', onPoi);
  map.on('click', 'poi-lbl', onPoi);
}

export async function setPois(list) {
  await ready;
  map.getSource('pois').setData({ type: 'FeatureCollection', features: list.map((p) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { name: p.name, kind: p.kind, g: p.group, ...(p.ele != null ? { ele: p.ele } : {}) },
  })) });
}

export function onPoiPick(cb) { ready.then(() => map.on('poipick', (e) => cb(e.poi))); }

// 旋转控件：「旋转模式」下左键/单指拖动 = 水平旋转 + 上下俯仰；另有 ±45° 旋转与自动环绕
class OrbitControl {
  onAdd(m) {
    this.m = m;
    const c = document.createElement('div');
    c.className = 'maplibregl-ctrl maplibregl-ctrl-group orbit-ctrl';
    c.innerHTML = `
      <button type="button" data-a="mode" title="旋转模式：拖动地图即绕观测点旋转/俯仰（再点一次回到平移）" aria-pressed="false">⟲<small>旋转</small></button>
      <button type="button" data-a="left" title="向左转 45°">↺</button>
      <button type="button" data-a="right" title="向右转 45°">↻</button>
      <button type="button" data-a="orbit" title="自动环绕观测点" aria-pressed="false">◎<small>环绕</small></button>`;
    c.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'mode') this.setMode(!this.rot);
      if (a === 'left' || a === 'right') { this.stopOrbit(); m.easeTo({ bearing: m.getBearing() + (a === 'left' ? -45 : 45), duration: 700 }); }
      if (a === 'orbit') (this.raf ? this.stopOrbit() : this.startOrbit());
    });
    this.c = c;
    this.bindDrag();
    const stop = () => this.stopOrbit();
    m.getCanvasContainer().addEventListener('wheel', stop, { passive: true });
    return c;
  }

  onRemove() { this.c.remove(); }

  btn(a) { return this.c.querySelector(`[data-a="${a}"]`); }

  setMode(on) {
    this.rot = on;
    this.btn('mode').setAttribute('aria-pressed', String(on));
    if (on) {
      this.m.dragPan.disable();
      if (marker) this.m.easeTo({ center: marker.getLngLat(), pitch: Math.max(this.m.getPitch(), 55), duration: 600 });
    } else this.m.dragPan.enable();
    this.m.getCanvasContainer().classList.toggle('rotating', on);
    this.m.fire('rotatemode', { on });
  }

  // 单指/左键在「旋转模式」下：水平 = 绕观测点环绕，垂直 = 俯仰；松手带惯性
  bindDrag() {
    const el = this.m.getCanvasContainer();
    let last = null;
    let vel = 0;
    const down = (x, y, btn) => {
      this.stopOrbit();
      this.stopSpin();
      if (!this.rot || btn > 0) return;
      last = { x, y, t: performance.now() };
      vel = 0;
    };
    const move = (x, y) => {
      if (!last) return;
      const now = performance.now();
      const dx = x - last.x;
      const dy = y - last.y;
      const dt = Math.max(1, now - last.t);
      last = { x, y, t: now };
      rotatedAt = now;
      const db = -dx * 0.4;
      vel = vel * 0.6 + (db / dt) * 0.4;
      this.m.jumpTo({ bearing: this.m.getBearing() + db, pitch: clampPitch(this.m.getPitch() - dy * 0.3) });
    };
    const up = () => {
      if (!last) return;
      rotatedAt = performance.now();
      if (performance.now() - last.t < 80 && Math.abs(vel) > 0.05) this.spin(vel);
      last = null;
    };
    el.addEventListener('mousedown', (e) => down(e.clientX, e.clientY, e.button));
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', up);
    el.addEventListener('touchstart', (e) => { if (e.touches.length === 1) down(e.touches[0].clientX, e.touches[0].clientY, 0); else last = null; }, { passive: true });
    el.addEventListener('touchmove', (e) => { if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    el.addEventListener('touchend', (e) => { if (!e.touches.length) up(); });
    el.addEventListener('touchcancel', () => { last = null; });
  }

  spin(v) {
    let t0 = performance.now();
    const tick = (t) => {
      const dt = Math.max(0, Math.min(64, t - t0));
      t0 = t;
      v *= Math.pow(0.992, dt);
      if (Math.abs(v) < 0.004) { this.spinRaf = null; return; }
      this.m.setBearing(this.m.getBearing() + v * dt);
      this.spinRaf = requestAnimationFrame(tick);
    };
    this.spinRaf = requestAnimationFrame(tick);
  }

  stopSpin() { if (this.spinRaf) cancelAnimationFrame(this.spinRaf); this.spinRaf = null; }

  startOrbit() {
    const m = this.m;
    const at = marker ? marker.getLngLat() : m.getCenter();
    m.jumpTo({ center: at, pitch: Math.max(m.getPitch(), 60) });
    this.btn('orbit').setAttribute('aria-pressed', 'true');
    let t0 = performance.now();
    const tick = (t) => {
      m.setBearing(m.getBearing() + (t - t0) * 0.006); // 约 6°/秒
      t0 = t;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stopOrbit() {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = null;
    this.btn('orbit').setAttribute('aria-pressed', 'false');
  }
}

const clampPitch = (p) => Math.max(0, Math.min(85, p));

// 双指手势（替代 MapLibre 自带的互斥式捏合/旋转/俯仰）：
// 捏合 = 缩放，捻转 = 旋转，双指同向上下推 = 俯仰，双指同向平移 = 平移；四者同时生效，不需要越过阈值“锁定”。
class TwoFingerGesture {
  constructor(m) {
    this.m = m;
    m.touchZoomRotate.disable();
    m.touchPitch.disable();
    const el = m.getCanvasContainer();
    el.addEventListener('touchstart', (e) => this.start(e), { passive: false });
    el.addEventListener('touchmove', (e) => this.move(e), { passive: false });
    el.addEventListener('touchend', (e) => this.end(e));
    el.addEventListener('touchcancel', (e) => this.end(e));
  }

  static geo(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const [a, b] = e.touches;
    const ax = a.clientX - r.left, ay = a.clientY - r.top, bx = b.clientX - r.left, by = b.clientY - r.top;
    return { cx: (ax + bx) / 2, cy: (ay + by) / 2, d: Math.hypot(bx - ax, by - ay), ang: Math.atan2(by - ay, bx - ax) * 180 / Math.PI };
  }

  start(e) {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    orbit?.stopOrbit();
    orbit?.stopSpin();
    this.panWasOn = this.m.dragPan.isEnabled();
    this.m.dragPan.disable(); // 防止 MapLibre 的多指平移与俯仰争抢
    this.m.stop();
    const g = TwoFingerGesture.geo(e);
    this.g = { ...g, zoom: this.m.getZoom(), bearing: this.m.getBearing(), pitch: this.m.getPitch() };
    this.prev = g;
  }

  move(e) {
    if (!this.g || e.touches.length !== 2) return;
    e.preventDefault();
    const g = TwoFingerGesture.geo(e);
    const g0 = this.g;
    let dAng = g.ang - g0.ang;
    if (dAng > 180) dAng -= 360;
    if (dAng < -180) dAng += 360;
    const dz = Math.log2(Math.max(g.d, 1) / Math.max(g0.d, 1));
    // 质心的竖直位移 → 俯仰；水平位移 → 平移（逐帧增量）
    const pdx = g.cx - this.prev.cx;
    const pitch = clampPitch(g0.pitch - (g.cy - g0.cy) * 0.35);
    this.prev = g;
    const c = this.m.project(this.m.getCenter());
    const center = Math.abs(pdx) > 0.5 ? this.m.unproject([c.x - pdx, c.y]) : this.m.getCenter();
    this.m.jumpTo({ zoom: g0.zoom + dz, bearing: g0.bearing - dAng, pitch, center });
    rotatedAt = performance.now();
  }

  end(e) {
    if (e.touches.length >= 2) return;
    if (this.g) { this.g = null; rotatedAt = performance.now(); this.pending = true; }
    // 等所有手指离开再恢复单指平移，避免剩下的那根手指让地图跳一下
    if (this.pending && e.touches.length === 0) {
      this.pending = false;
      if (this.panWasOn && !orbit?.rot) this.m.dragPan.enable();
    }
  }
}

export function getMap() { return map; }
