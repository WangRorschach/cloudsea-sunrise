// Regression tests for missing values, uncertain cloud tops and score semantics.
import assert from 'node:assert/strict';
import { analyzeCloudSea, analyzeSunrise, potentialTemp, dewpoint, stats, runForecast } from '../js/model.js';

function profile() {
  return [
    { z: 300, T: 8, RH: 98, ws: 2, cc: 75 },
    { z: 600, T: 6.5, RH: 99, ws: 2, cc: 80 },
    { z: 900, T: 5, RH: 97, ws: 3, cc: 85 },
    { z: 1150, T: 9, RH: 45, ws: 3, cc: 5 },
    { z: 1500, T: 9.5, RH: 35, ws: 4, cc: 0 },
    { z: 2000, T: 7, RH: 30, ws: 5, cc: 0 },
  ].map((l, k) => {
    const p = 1000 - k * 40;
    return { ...l, p, th: potentialTemp(l.T, p), Td: dewpoint(l.T, l.RH) };
  });
}
const ctx = { zObs: 1800, zValley: 300, cm: 5, ch: 10, precip: 0, rain24: 0, sunElev: -3 };
const good = analyzeCloudSea(profile(), ctx);
assert.ok(good.ztop > 900 && good.ztop < 1150);
assert.deepEqual(good.ztopRange, [900, 1150]);
assert.ok(good.P > 0 && good.P <= 100);
const inCloud = analyzeCloudSea(profile(), { ...ctx, zObs: 950 });
assert.ok(inCloud.ztop != null, 'cloud must exist even when viewpoint is inside it');
assert.ok(inCloud.P < good.P, 'lookout suitability must be lower inside clouds');
// Complete data with no saturated layer means an unfavorable score 0,
// not "missing", which previously left many full days blank.
const dryProfile = profile().map((l) => ({
  ...l, RH: 35, cc: 0, Td: dewpoint(l.T, 35),
}));
const unfavorable = analyzeCloudSea(dryProfile, { ...ctx, sunElev: 20 });
assert.equal(unfavorable.P, 0, 'unfavorable clear/dry conditions must show score 0');
assert.equal(unfavorable.diagnosis, 'unfavorable');
const missingPrecip = analyzeCloudSea(profile(), { ...ctx, precip: null });
assert.equal(missingPrecip.P, null, 'missing rain cannot be silently interpreted as dry');
const missingMidCloud = analyzeCloudSea(profile(), { ...ctx, cm: null });
assert.equal(missingMidCloud.P, null, 'missing mid cloud cannot be silently interpreted as clear sky');
const uncertain = profile().map((l) => ({ ...l }));
for (let i = 3; i < uncertain.length; i++) {
  uncertain[i].RH = 95;
  uncertain[i].Td = dewpoint(uncertain[i].T, 95);
}
uncertain[0].ws = 20; // suppress separate radiative-fog branch in this test
const top = analyzeCloudSea(uncertain, { ...ctx, cm: 100, ch: 100 });
assert.equal(top.P, null, 'unbounded cloud top cannot create a precise lookout score');
assert.ok(top.topEstimated);
const sunrise = {
  zObs: 1800, alphaDeg: -1.3, sea: good, cm: 35, ch: 20, precip: 0, aod: 0.2,
  samples: [10, 30, 70, 130, 200, 280].map((k) => ({ x: k * 1000, cl: 0, cm: 0, ch: 0 })),
};
assert.ok(analyzeSunrise(sunrise).Pvis > 0);
assert.equal(analyzeSunrise({ ...sunrise, samples: [] }).Pvis, null);
assert.equal(analyzeSunrise({ ...sunrise, samples: sunrise.samples.slice(0, 2) }).Pvis, null);
assert.equal(analyzeSunrise({ ...sunrise, samples: sunrise.samples.map((s) => ({ ...s, cl: null })) }).Pvis, null);
assert.equal(analyzeSunrise({ ...sunrise, precip: null }).Pvis, null);
assert.equal(analyzeSunrise({ ...sunrise, samples: [] }).glow, null);
assert.equal(stats([null, undefined]).mean, null);
assert.equal(stats([NaN, Infinity, 30]).mean, 30);

// Additional independent audit cases: explicit diagnoses distinguish 0 from unknown.
assert.match(unfavorable.diagnosisDetails, /未检出|阈值/);
assert.equal(missingPrecip.diagnosis, 'missing-input');
assert.match(missingPrecip.diagnosisDetails, /precip/);
assert.equal(top.diagnosis, 'unresolved-cloud-top');
assert.match(top.diagnosisDetails, /上界/);
assert.equal(good.diagnosis, 'resolved-cloud');
assert.equal(analyzeCloudSea([], ctx).diagnosis, 'insufficient-profile');
// Stagger the model peaks to verify the daily score uses a shared time.
{
  const layers = profile().map((layer, i) => ({ ...layer, p: [975, 950, 900, 850, 800, 750][i] }));
  const incomplete = analyzeCloudSea(layers.slice(-2), ctx);
  assert.equal(incomplete.P, null);
  assert.equal(incomplete.diagnosis, 'insufficient-profile');

  const offset = 28800;
  const localTimes = Array.from({ length: 24 }, (_, i) =>
    `2026-11-21T${String(i).padStart(2, '0')}:00`);
  const times = localTimes.map((time) => Date.parse(time + '+08:00'));
  const site = { lat: 27.457, lon: 114.168, zObs: 1800, zValley: 300 };
  const series = (fn) => localTimes.map((_, i) => fn(i));
  function model(id, peak, missing = false) {
    const surf = { cm: series(() => 5), ch: series(() => 10), precip: series(() => missing ? null : 0) };
    const levels = Object.fromEntries(layers.map((layer) => [layer.p, {
      z: series(() => layer.z), T: series(() => layer.T), ws: series(() => layer.ws),
      RH: series((i) => i === peak ? layer.RH : 35),
      cc: series((i) => i === peak ? layer.cc : 0),
    }]));
    return { id, available: true, surf, levels };
  }
  const run = (models) => runForecast({ fc: { models, localTimes, times, offset }, site });
  const win = run([model('A', 0)]).days[0].win;
  const staggered = run([model('A', win[0]), model('B', win[1])]);
  const day = staggered.days[0];
  assert.equal(day.sea.mean, staggered.hours[day.bestIdx].P.mean);
  assert.ok(day.sea.mean > 40 && day.sea.mean < 50);
  assert.equal(day.sea.min, 0);
  assert.equal(day.sea.n, 2);
  const partial = run([model('A', win[0]), model('B', win[1], true)]).days[0];
  assert.equal(partial.sea.n, 1);
  const missing = run([model('A', win[0], true)]).days[0];
  assert.equal(missing.bestIdx, null);
  assert.equal(missing.sea.mean, null);
}
console.log('Forecast integrity regression tests passed');
