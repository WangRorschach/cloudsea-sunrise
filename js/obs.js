// 现场观测记录与预测检验（本地浏览器存储，可导入导出）
const KEY_OBS = 'yh_obs_v1';
const KEY_SNAP = 'yh_snap_v1';

const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) ?? (k === KEY_OBS ? [] : {}); } catch { return k === KEY_OBS ? [] : {}; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export const siteKey = (s) => `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`;

// 记录每次查看到的预测（仅保留首次发布时最接近日出前 12–36 小时的版本，避免“事后预测”）
export function snapshotForecast(site, days) {
  const snap = load(KEY_SNAP);
  const now = Date.now();
  for (const d of days) {
    if (d.past || d.sea.mean == null) continue;
    const k = `${siteKey(site)}|${d.key}`;
    const lead = (d.rise.time - now) / 3600e3;
    const prev = snap[k];
    const better = !prev || (Math.abs(lead - 24) < Math.abs(prev.lead - 24));
    if (better) snap[k] = { lead, issued: now, sea: d.sea.mean, vis: d.vis.mean, glow: d.glow.mean, ztop: d.ztop.mean, name: site.name };
  }
  save(KEY_SNAP, snap);
}

export function listObs() { return load(KEY_OBS).sort((a, b) => b.date.localeCompare(a.date)); }

export function addObs(o) {
  const all = load(KEY_OBS);
  const snap = load(KEY_SNAP)[`${o.siteKey}|${o.date}`] ?? null;
  all.push({ ...o, id: crypto.randomUUID?.() ?? String(Date.now()), forecast: snap, created: Date.now() });
  save(KEY_OBS, all);
}

export function removeObs(id) { save(KEY_OBS, load(KEY_OBS).filter((o) => o.id !== id)); }

export function exportObs() {
  const blob = new Blob([JSON.stringify({ obs: load(KEY_OBS), snapshots: load(KEY_SNAP) }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cloudsea-observations-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

export async function importObs(file) {
  const j = JSON.parse(await file.text());
  const ids = new Set(load(KEY_OBS).map((o) => o.id));
  save(KEY_OBS, [...load(KEY_OBS), ...(j.obs ?? []).filter((o) => !ids.has(o.id))]);
  save(KEY_SNAP, { ...(j.snapshots ?? {}), ...load(KEY_SNAP) });
}

// 检验：Brier 评分、Brier 技巧评分（相对样本气候频率）、2×2 列联表
export function verify(obs, field, observedFn) {
  const pairs = obs.filter((o) => o.forecast?.[field] != null && observedFn(o) != null)
    .map((o) => ({ p: o.forecast[field] / 100, y: observedFn(o) }));
  if (!pairs.length) return null;
  const n = pairs.length;
  const bs = pairs.reduce((a, q) => a + (q.p - q.y) ** 2, 0) / n;
  const base = pairs.reduce((a, q) => a + q.y, 0) / n;
  const bsRef = base * (1 - base);
  const t = { a: 0, b: 0, c: 0, d: 0 };
  for (const q of pairs) {
    const f = q.p >= 0.5;
    if (f && q.y) t.a++; else if (f && !q.y) t.b++; else if (!f && q.y) t.c++; else t.d++;
  }
  return {
    n, bs, bss: bsRef > 0 ? 1 - bs / bsRef : null, base,
    pod: t.a + t.c ? t.a / (t.a + t.c) : null,
    far: t.a + t.b ? t.b / (t.a + t.b) : null,
    csi: t.a + t.b + t.c ? t.a / (t.a + t.b + t.c) : null,
    table: t,
  };
}
