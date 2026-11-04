// /api/celestrak-rcs: SATCAT radar cross-sections for Sky view brightness
// estimates, served beside the CelesTrak TLE proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  celestrakProxy,
  parseSatcatRcs,
  RCS_TTL_MS,
} from 'gods-eye-view/server/providers/space';
import { celestrakSatcatUrl } from 'gods-eye-view/sources/space';

const RCS_FILE = path.join(
  process.cwd(),
  '.gev-cache',
  'celestrak-satcat-rcs.json',
);
const HEADER =
  'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE';
// Rows copied from a live records.php?GROUP=ACTIVE&FORMAT=CSV response
// (2026-11-04), except the last, which is synthetic: the live response has no
// quoted name, but the format allows one.
const SATCAT_ROWS = [
  'CALSPHERE 1,1964-063C,900,PAY,+,US,1964-10-06,AFWTR,,104.59,90.22,994,957,0.0510,,EA,ORB',
  'HST,1990-037B,20580,PAY,+,US,1990-04-24,AFETR,,93.99,28.47,471,468,28.0799,,EA,ORB',
  'ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.95,51.63,424,414,399.0524,,EA,ORB',
  'STARLINK-1008,2019-074B,44714,PAY,P,US,2019-11-11,AFETR,,91.80,53.14,363,362,,,EA,ORB',
  'CSS (TIANHE),2021-035A,48274,PAY,+,PRC,2021-04-29,WSC,,92.23,41.47,387,381,,,EA,ORB',
  'SARAMAGO,2026-067CY,100000,PAY,+,POR,2026-03-30,AFWTR,,94.61,97.48,503,496,,,EA,ORB',
  '"SYNTHETIC, ""QUOTED"" SAT",2026-900A,100190,PAY,+,US,2026-01-01,AFETR,,95.00,97.30,560,555,2.5,,EA,ORB',
];
const SATCAT_CSV = [HEADER, ...SATCAT_ROWS].join('\r\n') + '\r\n';
const GP_CSV =
  'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION\r\nISS (ZARYA),1998-067A,2026-09-19T00:00:00.000000,15.5\r\n';
const T0 = Date.parse('2026-11-04T07:00:00Z');

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (url = '/', { method = 'GET', headers = {} } = {}) => {
    const res = {
      headersSent: false,
      headers: {},
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      // The same-site gate answers 403 through statusCode + setHeader.
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.body = body;
        this.status ??= this.statusCode;
      },
    };
    await routes.get('/api/celestrak-rcs')(
      { url, method, headers, socket: {} },
      res,
    );
    return res;
  };
}

/** Disk in memory: the proxy's cache directory is never touched. */
function memoryDisk(t, files = new Map()) {
  t.mock.method(fsp, 'readFile', async (file) => {
    if (!files.has(String(file)))
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files.get(String(file));
  });
  t.mock.method(fsp, 'writeFile', async (file, data) => {
    files.set(String(file), String(data));
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'stat', async () => {
    throw new Error('no stat');
  });
  return files;
}

function upstream(t, respond) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(calls.length);
  });
  return calls;
}

function clock(t, start = T0) {
  const state = { now: start };
  t.mock.method(Date, 'now', () => state.now);
  return state;
}

test('the SATCAT request is the documented records.php GROUP=ACTIVE CSV query', () => {
  const url = celestrakSatcatUrl();
  assert.equal(url.origin, 'https://celestrak.org');
  assert.equal(url.pathname, '/satcat/records.php');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    GROUP: 'ACTIVE',
    FORMAT: 'CSV',
  });
  assert.equal(RCS_TTL_MS, 7 * 24 * 3600_000);
});

test('parseSatcatRcs keeps positive RCS only and counts every row', () => {
  const parsed = parseSatcatRcs(SATCAT_CSV);
  assert.equal(parsed.rows, 7);
  assert.equal(parsed.withRcs, 4);
  assert.deepEqual(parsed.rcs, {
    900: 0.051,
    20580: 28.0799,
    25544: 399.0524,
    100190: 2.5,
  });
  assert.ok(!('48274' in parsed.rcs), 'empty RCS is no estimate');
  assert.ok(!('100000' in parsed.rcs), 'six-digit ids count as rows');
  // LF line ends, a BOM and a missing final newline parse the same
  assert.deepEqual(
    parseSatcatRcs('\uFEFF' + SATCAT_CSV.replaceAll('\r\n', '\n').trim()),
    parsed,
  );
});

test('parseSatcatRcs rejects anything that is not SATCAT CSV and skips malformed rows', () => {
  assert.equal(parseSatcatRcs('<html>busy</html>'), null);
  assert.equal(parseSatcatRcs(''), null);
  assert.equal(parseSatcatRcs(null), null);
  assert.equal(parseSatcatRcs(GP_CSV), null, 'a GP CSV is not a SATCAT');
  assert.equal(parseSatcatRcs(HEADER), null, 'header only');
  assert.equal(
    parseSatcatRcs(HEADER.replace('RCS', 'RCSX') + '\r\n' + SATCAT_ROWS[2]),
    null,
    'no RCS column',
  );
  assert.equal(
    parseSatcatRcs(
      HEADER.replace('OBJECT_NAME', 'NAME') + '\r\n' + SATCAT_ROWS[2],
    ),
    null,
    'wrong first column',
  );
  const messy = [
    HEADER,
    SATCAT_ROWS[2],
    'SHORT ROW,1999-001A,7', // truncated tail
    SATCAT_ROWS[0].replace(',900,', ',not-a-number,'),
    SATCAT_ROWS[1].replace('28.0799', '-3'), // negative
    SATCAT_ROWS[3].replace(',,,EA', ',n/a,,EA'), // not a number
    SATCAT_ROWS[4].replace(',,,EA', ',0,,EA'), // zero
  ].join('\n');
  const parsed = parseSatcatRcs(messy);
  assert.deepEqual(parsed.rcs, { 25544: 399.0524 });
  assert.equal(parsed.rows, 4, 'short and non-numeric-id rows are not rows');
  assert.equal(parsed.withRcs, 1);
});

test('first request fetches once with the fixed request, caches it, and serves it from memory and disk for 7 days', async (t) => {
  const files = memoryDisk(t);
  const time = clock(t);
  const calls = upstream(t, () => new Response(SATCAT_CSV));
  const request = install(celestrakProxy());

  const [a, b] = await Promise.all([request('/'), request('/?x=1')]);
  assert.equal(calls.length, 1, 'concurrent requests share one fetch');
  assert.equal(calls[0].url, celestrakSatcatUrl().toString());
  assert.match(
    calls[0].init.headers['User-Agent'],
    /^gods-eye-view-celestrak-proxy\/1\.0 \(\+https:\/\/github\.com\//,
  );
  assert.equal(
    calls[0].init.redirect,
    'manual',
    'a redirect is never followed',
  );
  assert.ok(calls[0].init.signal, 'bounded by a timeout');
  assert.equal(a.status, 200);
  assert.equal(a.headers['x-rcs-cache'], 'MISS');
  assert.equal(a.headers['Content-Type'], 'application/json');
  assert.equal(a.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(a.body), {
    fetchedAt: T0,
    rows: 7,
    withRcs: 4,
    rcs: { 900: 0.051, 20580: 28.0799, 25544: 399.0524, 100190: 2.5 },
  });
  assert.equal(b.body, a.body);
  assert.equal(JSON.parse(files.get(RCS_FILE)).at, T0, 'disk cache written');

  time.now += RCS_TTL_MS - 60_000;
  const hit = await request('/');
  assert.equal(hit.status, 200);
  assert.equal(hit.headers['x-rcs-cache'], 'HIT');
  assert.equal(hit.body, a.body);
  // a restarted server reads the disk cache instead of fetching
  const restarted = await install(celestrakProxy())('/');
  assert.equal(restarted.headers['x-rcs-cache'], 'HIT');
  assert.equal(restarted.body, a.body);
  assert.equal(calls.length, 1, 'no refetch inside 7 days');

  time.now += 120_000; // past 7 days
  const fresh = await request('/');
  assert.equal(fresh.headers['x-rcs-cache'], 'MISS');
  assert.equal(JSON.parse(fresh.body).fetchedAt, time.now);
  assert.equal(calls.length, 2);
});

test('an expired cache is served stale when the refresh fails, without hammering CelesTrak', async (t) => {
  const files = memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  const time = clock(t);
  files.set(
    RCS_FILE,
    JSON.stringify({
      at: T0 - RCS_TTL_MS - 1000,
      rows: 1,
      withRcs: 1,
      rcs: { 25544: 399.0524 },
    }),
  );
  let recovered = false;
  const calls = upstream(t, () =>
    recovered
      ? new Response(SATCAT_CSV)
      : new Response('busy', {
          status: 503,
          headers: { 'Retry-After': '120' },
        }),
  );
  const request = install(celestrakProxy());

  const stale = await request('/');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['x-rcs-cache'], 'STALE-ERROR');
  assert.deepEqual(JSON.parse(stale.body).rcs, { 25544: 399.0524 });
  assert.equal(calls.length, 1);
  // CelesTrak asks clients to stop after a non-200 answer: Retry-After holds
  const cooling = await request('/');
  assert.equal(cooling.headers['x-rcs-cache'], 'STALE-ERROR');
  assert.equal(cooling.headers['Retry-After'], '120');
  assert.equal(calls.length, 1, 'no request during the cooldown');
  assert.equal(
    JSON.parse(files.get(RCS_FILE)).at,
    T0 - RCS_TTL_MS - 1000,
    'a failure leaves the cache file alone',
  );

  time.now += 121_000;
  recovered = true;
  const afterCooldown = await request('/');
  assert.equal(afterCooldown.headers['x-rcs-cache'], 'MISS');
  assert.equal(calls.length, 2, 'the next refresh waits out the cooldown');
});

test('without any cache a failed fetch answers 502 and is not retried inside the cooldown', async (t) => {
  const files = memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  clock(t);
  const calls = upstream(t, () => new Response('forbidden', { status: 403 }));
  const request = install(celestrakProxy());

  const first = await request('/');
  assert.equal(first.status, 502);
  assert.equal(first.headers['x-rcs-cache'], 'NONE');
  assert.match(JSON.parse(first.body).error, /satcat fetch failed/);
  const second = await request('/');
  assert.equal(second.status, 502);
  assert.equal(second.headers['x-rcs-cache'], 'NONE');
  assert.ok(Number(second.headers['Retry-After']) > 0);
  assert.equal(calls.length, 1);
  assert.ok(!files.has(RCS_FILE), 'nothing cached');
});

test('a network error is a failure too', async (t) => {
  memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  const time = clock(t);
  const calls = upstream(t, (n) => {
    if (n === 1) throw new TypeError('fetch failed: unexpected redirect');
    return new Response(SATCAT_CSV);
  });
  const request = install(celestrakProxy());
  const first = await request('/');
  assert.equal(first.status, 502);
  assert.doesNotMatch(first.body, /redirect/, 'upstream detail is not echoed');
  time.now += 61_000;
  assert.equal((await request('/')).status, 200);
  assert.equal(calls.length, 2);
});

test('a 200 that is not SATCAT CSV is rejected and never cached', async (t) => {
  for (const body of ['<html>maintenance</html>', GP_CSV, HEADER + '\r\n']) {
    const files = memoryDisk(t);
    t.mock.method(console, 'warn', () => {});
    const calls = upstream(t, () => new Response(body));
    const res = await install(celestrakProxy())('/');
    assert.equal(res.status, 502, body.slice(0, 20));
    assert.equal(calls.length, 1);
    assert.ok(!files.has(RCS_FILE));
    t.mock.restoreAll();
  }
});

test('an oversized body is cut off at the cap and not cached', async (t) => {
  const files = memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  let cancelled = false;
  let pulled = 0;
  const chunk = new TextEncoder().encode('x'.repeat(1 << 20));
  upstream(
    t,
    () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (++pulled > 40) controller.close();
              else controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  const res = await install(celestrakProxy())('/');
  assert.equal(res.status, 502);
  assert.ok(cancelled, 'the stream is cancelled');
  assert.ok(pulled <= 10, `read ${pulled} MiB before stopping`);
  assert.ok(!files.has(RCS_FILE));
});

test('an unreadable or implausible disk cache is ignored', async (t) => {
  const files = memoryDisk(t);
  clock(t);
  const calls = upstream(t, () => new Response(SATCAT_CSV));
  for (const bad of [
    '{not json',
    JSON.stringify({ at: T0, rcs: [1, 2] }),
    JSON.stringify({ at: T0, rcs: { 25544: '399' } }),
    JSON.stringify({ at: T0, rcs: { 25544: -1 } }),
    JSON.stringify({ at: T0, rcs: { abc: 1 } }),
    JSON.stringify({ rcs: { 25544: 399 } }),
  ]) {
    files.set(RCS_FILE, bad);
    const res = await install(celestrakProxy())('/');
    assert.equal(res.headers['x-rcs-cache'], 'MISS', bad);
  }
  assert.equal(calls.length, 6);
});

test('only the bare GET route is served', async (t) => {
  memoryDisk(t);
  const calls = upstream(t, () => new Response(SATCAT_CSV));
  const request = install(celestrakProxy());
  for (const url of ['/x', '/stations', '/../stations', '/.json', '//', '/a/b'])
    assert.equal((await request(url)).status, 404, url);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD'])
    assert.equal((await request('/', { method })).status, 405, method);
  assert.equal(calls.length, 0, 'no upstream request for either');
});

test('a client cannot steer the upstream request', async (t) => {
  memoryDisk(t);
  const calls = upstream(t, () => new Response(SATCAT_CSV));
  const res = await install(celestrakProxy())(
    '/?GROUP=STARLINK&url=https://example.test/&CATNR=1',
  );
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, celestrakSatcatUrl().toString());
});

test('a cross-site browser request is refused before anything is read or fetched', async (t) => {
  memoryDisk(t);
  const calls = upstream(t, () => new Response(SATCAT_CSV));
  const request = install(celestrakProxy());
  const refused = await request('/', {
    headers: { host: 'localhost:4173', origin: 'https://evil.example' },
  });
  assert.equal(refused.status, 403);
  assert.equal(calls.length, 0);
  const sameOrigin = await request('/', {
    headers: { host: 'localhost:4173', origin: 'http://localhost:4173' },
  });
  assert.equal(sameOrigin.status, 200);
});

test('the SATCAT route is registered beside the TLE route', async (t) => {
  memoryDisk(t);
  const routes = new Map();
  celestrakProxy().configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/celestrak',
    '/api/celestrak-rcs',
  ]);
});

/** Both routes of one proxy instance, as the dev server mounts them. */
function installBoth(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/') => {
    const res = {
      headersSent: false,
      headers: {},
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.body = body;
        this.status ??= this.statusCode;
      },
    };
    await routes.get(route)(
      { url, method: 'GET', headers: {}, socket: {} },
      res,
    );
    return res;
  };
}

const TLE = 'ISS\n1 25544U fixture\n2 25544 fixture\n';

test('a SATCAT table with no radar cross-section at all is rejected and the cache is kept', async (t) => {
  const files = memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  clock(t);
  const good = parseSatcatRcs(SATCAT_CSV);
  files.set(RCS_FILE, JSON.stringify({ at: T0 - RCS_TTL_MS - 1, ...good }));
  // Same header and rows, RCS column blanked (a renamed or emptied column).
  const noRcs =
    [
      HEADER,
      ...SATCAT_ROWS.map((row) =>
        row.replace(/,[0-9.]+,,EA,ORB$/, ',,,EA,ORB'),
      ),
    ].join('\r\n') + '\r\n';
  assert.equal(parseSatcatRcs(noRcs).withRcs, 0);
  assert.ok(parseSatcatRcs(noRcs).rows > 0);
  const calls = upstream(t, () => new Response(noRcs));
  const res = await install(celestrakProxy())('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-rcs-cache'], 'STALE-ERROR');
  assert.equal(Object.keys(JSON.parse(res.body).rcs).length, good.withRcs);
  assert.equal(calls.length, 1);
  assert.equal(
    JSON.parse(files.get(RCS_FILE)).at,
    T0 - RCS_TTL_MS - 1,
    'disk cache untouched',
  );
});

test('a redirect, 403 or 404 holds the SATCAT route for six hours', async (t) => {
  for (const status of [301, 403, 404]) {
    memoryDisk(t);
    t.mock.method(console, 'warn', () => {});
    const time = clock(t);
    const calls = upstream(
      t,
      () =>
        new Response('', {
          status,
          headers:
            status === 301 ? { Location: 'https://example.invalid/x' } : {},
        }),
    );
    const request = install(celestrakProxy());
    assert.equal((await request('/')).status, 502, String(status));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual');
    time.now += 61_000;
    assert.equal((await request('/')).status, 502);
    assert.equal(calls.length, 1, `${status}: no retry after a minute`);
    time.now += 6 * 3600_000;
    await request('/');
    assert.equal(calls.length, 2, `${status}: tries again after six hours`);
    t.mock.restoreAll();
  }
});

test('an HTTP error from SATCAT pauses the TLE route too; a failure that is not an HTTP answer does not', async (t) => {
  // HTTP answer: CelesTrak asks clients to stop everywhere.
  memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  clock(t);
  let calls = upstream(t, () => new Response('slow down', { status: 429 }));
  let request = installBoth(celestrakProxy());
  assert.equal((await request('/api/celestrak-rcs')).status, 502);
  const tle = await request('/api/celestrak', '/stations');
  assert.equal(tle.status, 502);
  assert.equal(calls.length, 1, 'the TLE route made no upstream call');
  t.mock.restoreAll();

  // A body that does not parse: only the optional route waits.
  memoryDisk(t);
  t.mock.method(console, 'warn', () => {});
  clock(t);
  calls = upstream(t, (n) =>
    n === 1 ? new Response('<html>maintenance</html>') : new Response(TLE),
  );
  request = installBoth(celestrakProxy());
  assert.equal((await request('/api/celestrak-rcs')).status, 502);
  const ok = await request('/api/celestrak', '/stations');
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 2, 'the TLE route fetched normally');
  assert.equal((await request('/api/celestrak-rcs')).status, 502);
  assert.equal(calls.length, 2, 'the SATCAT route is paused');
});
