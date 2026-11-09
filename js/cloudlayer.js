// 3D 云海层：在预测云顶高度绘制若干层带分形噪声纹理的半透明云面（WebGL 自定义图层），
// 与地形共用深度缓冲，高于云顶的山峰自然“刺破”云面。
/* global maplibregl */

const VS = `
attribute vec2 a_pos;
uniform mat4 u_matrix;
uniform vec2 u_center;
uniform float u_half;
uniform float u_z;
varying vec2 v_p;
void main() {
  v_p = a_pos;
  gl_Position = u_matrix * vec4(u_center + a_pos * u_half, u_z, 1.0);
}`;

const FS = `
precision highp float;
varying vec2 v_p;
uniform float u_time;
uniform float u_km;      // 半径（km）
uniform float u_cover;   // 0..1 云量强度
uniform float u_layer;   // 0 顶层 .. 1 底层
uniform float u_alpha;
uniform vec3 u_lit;
uniform vec3 u_shade;
uniform vec2 u_sun;      // 太阳方位单位向量（地图坐标，x 东 y 北）
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { s += a * n(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
void main() {
  float r = length(v_p);
  if (r > 1.0) discard;
  vec2 km = v_p * u_km;
  vec2 drift = vec2(u_time * 0.018, u_time * 0.007);
  vec2 q = km / 2.2 + drift + u_layer * 13.0;
  float base = fbm(q);
  float det = fbm(q * 3.1 - drift * 2.0);
  float d = base * 0.75 + det * 0.25;
  // 云量越高，阈值越低 → 云面越连续
  float th = mix(0.62, 0.18, u_cover) + u_layer * 0.05;
  float a = smoothstep(th - 0.08, th + 0.16, d);
  // 朝向太阳的一侧更亮（以噪声梯度近似法线）
  float e = 0.06;
  vec2 g = vec2(fbm(q + vec2(e, 0.0)) - fbm(q - vec2(e, 0.0)), fbm(q + vec2(0.0, e)) - fbm(q - vec2(0.0, e)));
  float lit = clamp(0.62 + 2.6 * dot(-g, u_sun) + 0.35 * (d - th), 0.0, 1.0);
  vec3 col = mix(u_shade, u_lit, lit);
  float edge = 1.0 - smoothstep(0.72, 1.0, r);
  float alpha = a * edge * u_alpha * mix(1.0, 0.75, u_layer);
  gl_FragColor = vec4(col * alpha, alpha);
}`;

const TINTS = {
  night: { lit: [0.70, 0.75, 0.86], shade: [0.36, 0.41, 0.52] },
  dawn: { lit: [1.0, 0.86, 0.72], shade: [0.62, 0.58, 0.68] },
  day: { lit: [1.0, 1.0, 1.0], shade: [0.72, 0.77, 0.86] },
};

export class CloudSeaLayer {
  constructor() {
    this.id = 'cloudsea-3d';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.p = null;
    this.t0 = performance.now();
  }

  set(p) {
    this.p = p;
    this.map?.triggerRepaint();
  }

  onAdd(map, gl) {
    this.map = map;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr);
    this.pr = pr;
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.loc = {};
    for (const u of ['u_matrix', 'u_center', 'u_half', 'u_z', 'u_time', 'u_km', 'u_cover', 'u_layer', 'u_alpha', 'u_lit', 'u_shade', 'u_sun']) this.loc[u] = gl.getUniformLocation(pr, u);
    this.aPos = gl.getAttribLocation(pr, 'a_pos');
  }

  render(gl, args) {
    const p = this.p;
    if (!p || !p.visible) return;
    const m = this.map;
    const ex = m.getTerrain()?.exaggeration ?? 1;
    const c = maplibregl.MercatorCoordinate.fromLngLat([p.lon, p.lat], 0);
    const mpu = c.meterInMercatorCoordinateUnits();
    const tint = TINTS[p.tint] ?? TINTS.day;
    const time = (performance.now() - this.t0) / 1000;
    gl.useProgram(this.pr);
    gl.uniformMatrix4fv(this.loc.u_matrix, false, args.defaultProjectionData?.mainMatrix ?? args.modelViewProjectionMatrix ?? args);
    gl.uniform2f(this.loc.u_center, c.x, c.y);
    gl.uniform1f(this.loc.u_half, p.radius * mpu);
    gl.uniform1f(this.loc.u_time, time);
    gl.uniform1f(this.loc.u_km, p.radius / 1000);
    gl.uniform1f(this.loc.u_cover, p.cover);
    gl.uniform3fv(this.loc.u_lit, tint.lit);
    gl.uniform3fv(this.loc.u_shade, tint.shade);
    const az = ((p.sunAz ?? 110) * Math.PI) / 180;
    gl.uniform2f(this.loc.u_sun, Math.sin(az), Math.cos(az));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // 自下而上画 4 层：云顶下方 0/25/55/90 m，营造云层厚度与边缘的柔和过渡
    const offs = [90, 55, 25, 0];
    offs.forEach((dz, k) => {
      const z = Math.max(0, p.top - dz) * ex;
      gl.uniform1f(this.loc.u_z, z * mpu);
      gl.uniform1f(this.loc.u_layer, 1 - k / (offs.length - 1));
      gl.uniform1f(this.loc.u_alpha, p.alpha * (k === offs.length - 1 ? 0.95 : 0.55));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });
    gl.depthMask(true);
    // 缓慢飘动：约 15 fps 重绘，避免持续满帧占用 GPU
    if (p.animate !== false && !this.pending) {
      this.pending = setTimeout(() => { this.pending = null; m.triggerRepaint(); }, 66);
    }
  }
}
