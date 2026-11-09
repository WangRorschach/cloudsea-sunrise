// 太阳位置：NOAA / Meeus《Astronomical Algorithms》简化算法，精度约 ±1 分钟、±0.1°
const rad = Math.PI / 180;
const deg = 180 / Math.PI;

export const R_EARTH = 6371000;
// 标准大气折射系数 k≈0.13，等效地球半径
export const REFRACTION_K = 0.13;
export const R_EFF = R_EARTH / (1 - REFRACTION_K);

export function solarPosition(date, lat, lon) {
  const ms = date instanceof Date ? date.getTime() : date;
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * rad) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime =
    4 * deg *
    (y * Math.sin(2 * L0 * rad) -
      2 * e * Math.sin(M * rad) +
      4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad) -
      0.5 * y * y * Math.sin(4 * L0 * rad) -
      1.25 * e * e * Math.sin(2 * M * rad));
  const minutesUTC = (((ms / 60000) % 1440) + 1440) % 1440;
  const tst = (((minutesUTC + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = (tst / 4 - 180) * rad;
  const phi = lat * rad;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  const az = (Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) * deg + 180 + 360) % 360;
  return { elevation: 90 - zen * deg, azimuth: az, declination: decl * deg };
}

// 眼高差（几何地平俯角，含标准折射），单位：度
export function horizonDip(heightAboveSurfaceM) {
  if (heightAboveSurfaceM <= 0) return 0;
  return Math.sqrt((2 * heightAboveSurfaceM) / R_EFF) * deg;
}

// Bennett (1982) 大气折射公式，输入视高度（度），输出折射量（度）
export function bennettRefraction(apparentDeg) {
  const h = Math.max(apparentDeg, -1.9);
  return 1 / Math.tan((h + 7.31 / (h + 4.4)) * rad) / 60;
}

// 太阳上缘与给定视地平高度相切时，日心的几何高度
export function sunriseGeometricTarget(horizonAltDeg) {
  return horizonAltDeg - bennettRefraction(horizonAltDeg) - 0.2666;
}

// 在 [startMs, endMs] 内寻找太阳几何高度首次向上穿越 targetDeg 的时刻
export function findRise(startMs, endMs, lat, lon, targetDeg, stepMs = 60000) {
  let prev = solarPosition(startMs, lat, lon).elevation - targetDeg;
  for (let t = startMs + stepMs; t <= endMs; t += stepMs) {
    const cur = solarPosition(t, lat, lon).elevation - targetDeg;
    if (prev < 0 && cur >= 0) {
      const tt = t - stepMs + (stepMs * -prev) / (cur - prev);
      return { time: tt, azimuth: solarPosition(tt, lat, lon).azimuth };
    }
    prev = cur;
  }
  return null;
}

// 沿给定方位角，从起点出发 distM 米处的经纬度（球面大圆）
export function destination(lat, lon, bearingDeg, distM) {
  const d = distM / R_EARTH;
  const b = bearingDeg * rad;
  const p1 = lat * rad;
  const l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 * deg, ((l2 * deg + 540) % 360) - 180];
}

// 视线（光线）在距离 x 处的海拔：考虑地球曲率与标准折射
export function rayHeight(xM, h0, alphaDeg) {
  return h0 + xM * Math.tan(alphaDeg * rad) + (xM * xM) / (2 * R_EFF);
}

// 地形视高度角（度）
export function terrainAngle(xM, groundM, h0) {
  return Math.atan((groundM - h0) / xM - xM / (2 * R_EFF)) * deg;
}
