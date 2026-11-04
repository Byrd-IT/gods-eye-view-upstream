import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  celestrakSatcatUrl,
  celestrakTleUrl,
} from '../../../src/data/spaceProviderRequests.js';
import { providerCooldownMs } from './cooldown.js';
import { admitSameSiteKeyless } from '../common/same-site.js';
import { readResponseTextCapped } from '../common/http.js';

/** How long a SATCAT radar-cross-section table is served before a refetch. */
export const RCS_TTL_MS = 7 * 24 * 3600_000;

/**
 * RFC 4180 CSV text -> rows of fields (quoted fields, doubled quotes, CRLF or
 * LF line ends; blank lines are skipped).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text);
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      endRow();
    } else field += c;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/**
 * CelesTrak SATCAT CSV -> `{ rows, withRcs, rcs: { noradId: rcsM2 } }`, keeping
 * only objects with a positive radar cross-section (SATCAT leaves `RCS` empty
 * when it has none; consumers treat a missing id as "no estimate"). The header
 * row must start with `OBJECT_NAME` and name `NORAD_CAT_ID` and `RCS`; rows
 * whose field count differs from the header (a truncated tail) are skipped.
 * Returns null when the text is not SATCAT CSV (an error page, a GP CSV) or
 * has no data rows.
 * @param {string} text
 * @returns {{ rows: number, withRcs: number, rcs: Record<string, number> } | null}
 */
export function parseSatcatRcs(text) {
  if (typeof text !== 'string') return null;
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''));
  const header = rows.shift() || [];
  const idCol = header.indexOf('NORAD_CAT_ID');
  const rcsCol = header.indexOf('RCS');
  if (header[0] !== 'OBJECT_NAME' || idCol < 0 || rcsCol < 0) return null;
  const rcs = {};
  let count = 0;
  let withRcs = 0;
  for (const r of rows) {
    if (r.length !== header.length) continue;
    const id = Number(r[idCol]);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    count += 1;
    const raw = r[rcsCol].trim();
    const value = raw === '' ? NaN : Number(raw);
    if (Number.isFinite(value) && value > 0) {
      rcs[id] = value;
      withRcs += 1;
    }
  }
  return count ? { rows: count, withRcs, rcs } : null;
}

/**
 * Vite plugin: CelesTrak TLE proxy.
 *
 * CelesTrak does not send CORS headers, so this middleware fetches
 * satellite TLE data server-side and forwards it to the browser.
 * Upstream URL: https://celestrak.org/NORAD/elements/gp.php
 *
 * @returns {import('vite').Plugin}
 */
/**
 * CelesTrak GP/TLE proxy with a memory + disk cache.
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * CelesTrak asks clients not to re-fetch GP data more than ~every 2 h and
 * throttles offenders; every dev reload used to refetch every group. Cache TTL
 * 6 h; on upstream failure the freshest stale copy is served (a stale TLE
 * beats an empty satellites layer). Pattern mirrors openSkyProxy's
 * cache+serve-stale. Adapted from skylight's TleStore (MIT).
 *
 * Also serves `/api/celestrak-rcs`: the SATCAT radar cross-sections of the
 * active catalog as compact JSON for Sky view's brightness estimates
 * (see "SATCAT radar cross-sections" below).
 */
export function celestrakProxy() {
  const TLE_TTL_MS = 6 * 3600_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const groups = new Set([
    'stations',
    'visual',
    'gps-ops',
    'glo-ops',
    'galileo',
    'geo',
    'starlink',
    // Space Missions (`getActiveTle`) reads the full active catalog.
    'active',
  ]);
  let cooldownUntil = 0;
  const mem = new Map(); // group -> { at: epochMs, body: string }
  const inflight = new Map(); // group -> Promise<{at, body}|null>

  const diskPath = (group) => path.join(CACHE_DIR, `celestrak-${group}.json`);

  async function readDisk(group) {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath(group), 'utf8'));
      if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at))
        return parsed;
    } catch {
      /* no disk cache yet */
    }
    return null;
  }

  async function writeDisk(group, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(diskPath(group), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[celestrak-proxy] cache write failed');
    }
  }

  /** The largest group (`active`) measures ~2.7 MB; this bounds a runaway body. */
  const CELESTRAK_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

  // CelesTrak 403s bulk requests unless they carry a descriptive User-Agent
  // with a contact point.
  const USER_AGENT =
    'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

  async function fetchUpstream(group) {
    const url = celestrakTleUrl(group);
    const signal = AbortSignal.timeout(20000);
    const res = await fetch(url.toString(), {
      signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) {
      // Group refreshes run in parallel: a later failure without Retry-After
      // must never shorten a longer deadline an earlier one already set.
      cooldownUntil = Math.max(
        cooldownUntil,
        Date.now() + providerCooldownMs(res),
      );
      void res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await readResponseTextCapped(
      res,
      CELESTRAK_MAX_RESPONSE_BYTES,
      signal,
    );
    // An upstream error page parses to zero TLEs — treat as failure, keep cache.
    if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
    return { at: Date.now(), body };
  }

  // --- SATCAT radar cross-sections (`/api/celestrak-rcs`) -----------------
  // Sky view estimates satellite brightness from the radar cross-section.
  // The values rarely change, so one copy is served for RCS_TTL_MS and fetched
  // only on demand. The request is fixed (no client input reaches the
  // upstream URL), never follows a redirect, and is bounded in bytes and time.
  // CelesTrak asks clients to stop after any non-200 answer, so an HTTP error
  // pauses the TLE groups too (`cooldownUntil`); a redirect, 403 or 404, which
  // it asks to have looked at, also holds this route for RCS_HOLD_MS. Failures
  // that are not an HTTP answer (a timeout, a body that does not parse) pause
  // only this optional route, never the satellites layer (`rcsCooldownUntil`).
  const RCS_FILE = path.join(CACHE_DIR, 'celestrak-satcat-rcs.json');
  /** The active SATCAT CSV measures ~1.5 MB; this bounds a runaway body. */
  const RCS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  let rcsMem = null; // { at, rows, withRcs, rcs: { noradId: m2 } }
  let rcsInflight = null; // Promise<entry|null>
  let rcsCooldownUntil = 0;
  const RCS_HOLD_MS = 6 * 3600_000;
  const rcsWaitUntil = () => Math.max(cooldownUntil, rcsCooldownUntil);

  const isRcsEntry = (v) =>
    Number.isFinite(v?.at) &&
    v.rcs !== null &&
    typeof v.rcs === 'object' &&
    !Array.isArray(v.rcs) &&
    Object.entries(v.rcs).every(
      ([id, m2]) =>
        Number.isSafeInteger(Number(id)) &&
        typeof m2 === 'number' &&
        m2 > 0 &&
        m2 < Infinity,
    );

  async function readRcsDisk() {
    try {
      const parsed = JSON.parse(await fsp.readFile(RCS_FILE, 'utf8'));
      if (isRcsEntry(parsed)) return parsed;
    } catch {
      /* no disk cache yet */
    }
    return null;
  }

  async function fetchRcsUpstream() {
    const signal = AbortSignal.timeout(30000);
    const res = await fetch(celestrakSatcatUrl().toString(), {
      signal,
      // A redirect is an answer to look at, not one to follow to any other
      // host: it is returned as a non-200 status below.
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) {
      const wait = providerCooldownMs(res);
      const attention =
        (res.status >= 300 && res.status < 400) ||
        res.status === 403 ||
        res.status === 404;
      cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
      rcsCooldownUntil = Math.max(
        rcsCooldownUntil,
        Date.now() + (attention ? Math.max(wait, RCS_HOLD_MS) : wait),
      );
      void res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const parsed = parseSatcatRcs(
      await readResponseTextCapped(res, RCS_MAX_RESPONSE_BYTES, signal),
    );
    // An error page, a changed format or a blanked RCS column parses to
    // nothing useful (about 5% of the active catalogue has an RCS): keep the
    // cache.
    if (!parsed || parsed.withRcs === 0)
      throw new Error('no SATCAT radar cross-sections in response');
    return { at: Date.now(), ...parsed };
  }

  async function handleRcs(req, res) {
    const send = (status, body, cacheStatus) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'x-rcs-cache': cacheStatus,
        'Cache-Control': 'no-store',
        ...(Date.now() < rcsWaitUntil()
          ? {
              'Retry-After': String(
                Math.ceil((rcsWaitUntil() - Date.now()) / 1000),
              ),
            }
          : {}),
      });
      res.end(JSON.stringify(body));
    };
    const payload = (entry) => ({
      fetchedAt: entry.at,
      rows: entry.rows ?? null,
      withRcs: Object.keys(entry.rcs).length,
      rcs: entry.rcs,
    });
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    // Only the bare route: connect also hands over "/.json" and "/x".
    const rest = String(req.url || '').split('?')[0];
    if (rest !== '' && rest !== '/') {
      send(404, { error: 'not found' }, 'NONE');
      return;
    }
    try {
      let entry = rcsMem;
      if (!entry || Date.now() - entry.at >= RCS_TTL_MS) {
        const fromDisk = await readRcsDisk();
        if (fromDisk && (!entry || fromDisk.at > entry.at))
          entry = rcsMem = fromDisk;
      }
      if (entry && Date.now() - entry.at < RCS_TTL_MS) {
        send(200, payload(entry), 'HIT');
        return;
      }
      if (Date.now() < rcsWaitUntil()) {
        if (entry) send(200, payload(entry), 'STALE-ERROR');
        else send(502, { error: 'celestrak upstream cooling down' }, 'NONE');
        return;
      }
      // Stale or missing → refresh, single-flight.
      if (!rcsInflight) {
        rcsInflight = fetchRcsUpstream()
          .then(async (fresh) => {
            rcsMem = fresh;
            try {
              await fsp.mkdir(CACHE_DIR, { recursive: true });
              await fsp.writeFile(RCS_FILE, JSON.stringify(fresh), 'utf8');
            } catch {
              console.warn('[celestrak-proxy] rcs cache write failed');
            }
            return fresh;
          })
          .catch(() => {
            // Only this route waits for a failure that was not an HTTP
            // answer; an HTTP answer already set both deadlines.
            if (Date.now() >= rcsCooldownUntil)
              rcsCooldownUntil = Date.now() + 60000;
            console.warn(
              '[celestrak-proxy] rcs refresh failed — serving cache if any',
            );
            return null;
          })
          .finally(() => {
            rcsInflight = null;
          });
      }
      const fresh = await rcsInflight;
      if (fresh) send(200, payload(fresh), 'MISS');
      else if (entry) send(200, payload(entry), 'STALE-ERROR');
      else
        send(
          502,
          { error: 'satcat fetch failed and no cache available' },
          'NONE',
        );
    } catch {
      console.error('[celestrak-proxy] rcs request failed');
      send(500, { error: 'celestrak rcs proxy error' }, 'ERROR');
    }
  }

  const installMiddleware = (server) => {
    // Connect would not route "/api/celestrak-rcs" to the "/api/celestrak"
    // handler below (the next character is not "/"), so it needs its own.
    server.middlewares.use('/api/celestrak-rcs', handleRcs);
    server.middlewares.use('/api/celestrak', async (req, res) => {
      const group = String(req.url || '')
        .replace(/^\//, '')
        .split('?')[0];
      // Keyless and needed to render the satellites layer: refuse cross-site
      // browsers but keep the documented reverse-proxy deployment working.
      if (admitSameSiteKeyless(req, res)) return;
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (!groups.has(group)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('invalid group');
        return;
      }
      const send = (status, body, cacheStatus, entry) => {
        // Guard against a double-send (e.g. a throw AFTER a response already
        // went out routing into the catch's send): writeHead after headersSent
        // throws "Cannot set headers after they are sent".
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'text/plain',
          'x-tle-cache': cacheStatus,
          'Cache-Control': 'no-store',
          ...(entry
            ? { 'X-TLE-Cached-At': new Date(entry.at).toISOString() }
            : {}),
          ...(cooldownUntil > 0 && Date.now() < cooldownUntil
            ? {
                'Retry-After': String(
                  Math.ceil((cooldownUntil - Date.now()) / 1000),
                ),
              }
            : {}),
        });
        res.end(body);
      };
      try {
        const now = Date.now();
        let entry = mem.get(group);
        if (!entry) {
          entry = await readDisk(group);
          if (entry) mem.set(group, entry);
        }
        if (entry && now - entry.at < TLE_TTL_MS) {
          send(200, entry.body, 'HIT', entry);
          return;
        }
        if (Date.now() < cooldownUntil) {
          send(
            entry ? 200 : 502,
            entry?.body || 'celestrak upstream cooling down',
            entry ? 'STALE-ERROR' : 'NONE',
            entry,
          );
          return;
        }
        // Stale or missing → refresh, single-flight per group.
        if (!inflight.has(group)) {
          inflight.set(
            group,
            fetchUpstream(group)
              .then(async (fresh) => {
                mem.set(group, fresh);
                await writeDisk(group, fresh);
                return fresh;
              })
              .catch((err) => {
                if (Date.now() >= cooldownUntil)
                  cooldownUntil = Date.now() + 60000;
                console.warn(
                  '[celestrak-proxy] refresh failed — serving cache if any',
                );
                return null;
              })
              .finally(() => inflight.delete(group)),
          );
        }
        const fresh = await inflight.get(group);
        if (fresh) {
          send(200, fresh.body, 'MISS', fresh);
        } else if (entry) {
          send(200, entry.body, 'STALE-ERROR', entry); // upstream down — stale beats empty
        } else {
          send(502, 'celestrak fetch failed and no cache available', 'NONE');
        }
      } catch (err) {
        console.error('[celestrak-proxy] request failed');
        send(500, 'celestrak proxy error', 'ERROR');
      }
    });
  };
  return {
    name: 'celestrak-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
