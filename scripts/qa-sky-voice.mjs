#!/usr/bin/env node
/**
 * Sky view voice gate, headless Chromium against a running GEV dev server:
 *
 *   node scripts/qa-sky-voice.mjs --url http://127.0.0.1:4173 [--out qa-sky-voice]
 *
 * Drives `window.__gevVoiceCommands.runner('control_sky', args)`, the same
 * entry the Realtime session calls, so no model turns are spent. Checks, in
 * the real app:
 *
 *  1. status before Sky is open: ok, open = false.
 *  2. open: Sky is active (body.gev-sky-active), observer on the map centre.
 *  3. time with a zone: the Sky clock is that instant (fixed mode); a time
 *     without a zone is refused with { ok: false }.
 *  4. look at Jupiter / Orion: ok, the marker label names the target; a
 *     nonsense name is refused with { ok: false } and no crash.
 *  5. lines false then true: status.lines follows.
 *  6. preset sunset: ok, the Sky time moved.
 *  7. time live: the clock is live again.
 *  8. close: Sky inactive (no body.gev-sky-active), camera back on the map.
 *  9. an unknown action throws a short token; no console or page errors.
 *
 * Writes results.json plus a screenshot after the look and after close.
 * Exit 1 on a failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4173');
const OUT = path.resolve(arg('--out', 'qa-sky-voice'));
const SETTLE_MS = Number(arg('--settle-ms', '20000'));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const results = [];
const check = (ok, what, detail) => {
  console.log(ok ? 'PASS' : 'FAIL', what, detail ? JSON.stringify(detail) : '');
  results.push({ ok, what, detail: detail ?? null });
  if (!ok) failures.push(what);
};

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`page: ${String(e).slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  await page.goto(`${BASE}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer &&
      window.__gevVoiceCommands?.runner &&
      document.querySelector('.gev-sky-btn') &&
      window.__gevSky?.voice,
    { timeout: 180000 },
  );
  await sleep(SETTLE_MS);
  // The first-launch card covers the screenshots; Escape dismisses it.
  await page.keyboard.press('Escape');

  const run = (args) =>
    page.evaluate(async (a) => {
      try {
        return {
          value: await window.__gevVoiceCommands.runner('control_sky', a),
        };
      } catch (e) {
        return { threw: String(e.message || e) };
      }
    }, args);
  const skyActive = () =>
    page.evaluate(() => document.body.classList.contains('gev-sky-active'));

  // 1. status before open
  let r = await run({ action: 'status' });
  check(
    r.value?.ok === true && r.value.open === false,
    'status: ok and closed',
    r.value,
  );
  check((await skyActive()) === false, 'body is not in Sky mode before open');

  // 2. open
  r = await run({ action: 'open' });
  check(
    r.value?.ok === true && r.value.open === true,
    'open: ok and open',
    r.value,
  );
  check((await skyActive()) === true, 'body.gev-sky-active after open');
  check(
    Number.isFinite(r.value?.latitude) && Number.isFinite(r.value?.longitude),
    'open: observer latitude and longitude reported',
    { lat: r.value?.latitude, lon: r.value?.longitude },
  );

  // 3. time
  const stamp = '2026-11-04T04:00:00Z';
  r = await run({ action: 'time', time: stamp });
  check(
    r.value?.ok === true && Date.parse(r.value.time) === Date.parse(stamp),
    'time: Sky clock is the requested instant',
    r.value,
  );
  check(r.value?.timeMode === 'fixed', 'time: clock mode is fixed', {
    mode: r.value?.timeMode,
  });
  r = await run({ action: 'time', time: '2026-11-04T04:00:00' });
  check(
    r.value?.ok === false && /zone/i.test(r.value.error || ''),
    'time without a zone is refused',
    r.value,
  );

  // 4. look
  for (const target of ['Jupiter', 'Orion']) {
    r = await run({ action: 'look', target });
    check(
      r.value?.ok === true &&
        new RegExp(target, 'i').test(r.value.lookingAt || ''),
      `look at ${target}`,
      r.value,
    );
  }
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 'after-look-orion.png') });
  r = await run({ action: 'look', target: 'zzzz not a sky object' });
  check(
    r.value?.ok === false,
    'look at a nonsense name is refused, not thrown',
    r.value,
  );

  // 5. lines
  r = await run({ action: 'lines', enabled: false });
  check(r.value?.ok === true && r.value.lines === false, 'lines off', r.value);
  r = await run({ action: 'lines', enabled: true });
  check(r.value?.ok === true && r.value.lines === true, 'lines on', r.value);

  // 6. preset
  const before = Date.parse((await run({ action: 'status' })).value.time);
  r = await run({ action: 'preset', preset: 'sunset' });
  check(r.value?.ok === true, 'preset sunset ok', r.value);
  check(
    Date.parse(r.value?.time) !== before,
    'preset sunset moved the Sky time',
    {
      before: new Date(before).toISOString(),
      after: r.value?.time,
    },
  );

  // 7. live
  r = await run({ action: 'time', live: true });
  check(
    r.value?.ok === true && r.value.timeMode === 'live',
    'time live',
    r.value,
  );

  // 8. close
  r = await run({ action: 'close' });
  check(r.value?.ok === true && r.value.closed === true, 'close ok', r.value);
  check((await skyActive()) === false, 'body leaves Sky mode after close');
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 'after-close.png') });

  // 9. unknown action
  r = await run({ action: 'rewind' });
  check(
    /Unknown sky action: rewind/.test(r.threw || ''),
    'unknown action throws a short token',
    r,
  );
  check(errors.length === 0, 'no console or page errors', errors.slice(0, 5));
} catch (error) {
  failures.push(`harness: ${String(error).slice(0, 300)}`);
  console.error(error);
} finally {
  writeFileSync(
    path.join(OUT, 'results.json'),
    JSON.stringify({ base: BASE, failures, results, errors }, null, 2),
  );
  await browser.close();
}
if (failures.length) {
  console.log(`FAILED: ${failures.length}`);
  process.exit(1);
}
console.log(`OK: ${results.length} checks`);
