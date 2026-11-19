// Offline contract tests: DEM percentile retains the original valley coordinate,
// and independently requested NWP valley variables remain model-indexed.
import assert from 'node:assert/strict';
import { fetchSiteTerrain, fetchValleyForecast } from '../js/data.js';
import { destination } from '../js/sun.js';

const lat = 27.4552;
const lon = 114.1733;
const models = ['ecmwf_ifs025', 'gfs_seamless'];
let requests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, { signal } = {}) => {
  const url = new URL(String(input));
  requests++;
  assert.ok(!signal?.aborted);
  if (url.pathname.endsWith('/elevation')) {
    const n = url.searchParams.get('latitude').split(',').length;
    assert.equal(n, 37, 'summit + 36 ring points expected');
    return {
      ok: true, status: 200,
      json: async () => ({ elevation: Array.from({ length: n }, (_, i) => i === 0 ? 1918 : 2000 - 10 * i) }),
    };
  }
  assert.ok(url.pathname.endsWith('/forecast'));
  assert.equal(url.searchParams.get('models'), models.join(','));
  assert.equal(url.searchParams.get('forecast_days'), '7');
  assert.equal(url.searchParams.get('past_days'), '1');
  assert.equal(url.searchParams.get('elevation'), '1690', 'DEM 15th percentile altitude');
  const fields = url.searchParams.get('hourly').split(',');
  assert.deepEqual(fields, [
    'temperature_2m', 'relative_humidity_2m', 'cloud_cover_low',
    'wind_speed_10m', 'precipitation',
  ]);
  const time = ['2026-11-19T06:00', '2026-11-19T07:00'];
  const hourly = { time };
  models.forEach((m, k) => {
    hourly['temperature_2m_' + m] = [8 + k, 9 + k];
    hourly['relative_humidity_2m_' + m] = [98 - k, 93 - k];
    hourly['cloud_cover_low_' + m] = [40 + k, 20 + k];
    hourly['wind_speed_10m_' + m] = [2 + k, 2 + k];
    hourly['precipitation_' + m] = [0, 0];
  });
  return { ok: true, status: 200, json: async () => ({ hourly, timezone: 'Asia/Shanghai' }) };
};

try {
  const terrain = await fetchSiteTerrain(lat, lon);
  assert.equal(terrain.dem, 1918);
  assert.equal(terrain.valley, 1690);
  const expected = destination(lat, lon, 180, 9000);
  assert.ok(Math.abs(terrain.valleyPoint.lat - expected[0]) < 0.00001);
  assert.ok(Math.abs(terrain.valleyPoint.lon - expected[1]) < 0.00001);
  const forecast = await fetchValleyForecast(terrain.valleyPoint, models);
  assert.equal(forecast.point.z, 1690);
  assert.deepEqual(forecast.localTimes, ['2026-11-19T06:00', '2026-11-19T07:00']);
  assert.deepEqual(forecast.models.ecmwf_ifs025.RH2, [98, 93]);
  assert.deepEqual(forecast.models.gfs_seamless.cl, [41, 21]);
  assert.deepEqual(forecast.models.gfs_seamless.wind10, [3, 3]);
  assert.equal(await fetchValleyForecast(null, models), null);
  assert.equal(requests, 2);
  console.log('Valley DEM and Open-Meteo normalization contract tests passed');
} finally {
  globalThis.fetch = originalFetch;
}
