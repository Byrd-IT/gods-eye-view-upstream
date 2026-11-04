import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevActionRunner } from './gevActions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import {
  SKY_PRESET_IDS,
  SKY_VOICE_ACTIONS,
  createSkyVoice,
} from '../skyView/skyVoice.js';

globalThis.window = globalThis.window || {
  clearTimeout,
  setTimeout,
  requestIdleCallback: null,
};

function harness({ voiceOverrides = {}, sky = undefined } = {}) {
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const calls = [];
  const rec =
    (name, result) =>
    async (...args) => {
      calls.push([name, ...args]);
      return { ok: true, open: true, ...result };
    };
  const voice = {
    status: rec('status', { open: false, lines: true }),
    open: rec('open', { opened: true }),
    close: rec('close', { open: false, closed: true }),
    look: rec('look', { target: 'Jupiter', kind: 'body' }),
    time: rec('time', { time: '2026-10-26T04:00:00.000Z' }),
    lines: rec('lines', { lines: false }),
    preset: rec('preset', { preset: 'sunset' }),
    ...voiceOverrides,
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    ...(sky === undefined ? { sky: () => voice } : { sky }),
  });
  return { runner, calls, voice };
}

test('control_sky is the last Realtime tool and leaves the earlier order alone', () => {
  const names = GEV_REALTIME_TOOLS.map((tool) => tool.name);
  assert.equal(names.at(-1), 'control_sky');
  assert.equal(names.at(-2), 'next_satellite_pass');
  assert.equal(names.at(-3), 'next_iss_pass');
  const tool = GEV_REALTIME_TOOLS.find((t) => t.name === 'control_sky');
  assert.deepEqual(tool.parameters.properties.action.enum, [
    ...SKY_VOICE_ACTIONS,
  ]);
  assert.deepEqual(tool.parameters.properties.preset.enum, [...SKY_PRESET_IDS]);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.target.maxLength, 80);
  assert.equal(tool.parameters.properties.time.maxLength, 40);
  assert.equal(tool.parameters.properties.enabled.type, 'boolean');
});

test('control_sky open, close, look, time, lines, preset and status reach Sky', async () => {
  const h = harness();
  assert.equal(
    (await h.runner('control_sky', { action: 'open' })).opened,
    true,
  );
  assert.equal(
    (await h.runner('control_sky', { action: 'close' })).closed,
    true,
  );
  assert.equal(
    (await h.runner('control_sky', { action: 'look', target: 'Jupiter' }))
      .target,
    'Jupiter',
  );
  assert.equal(
    (
      await h.runner('control_sky', {
        action: 'time',
        time: '2026-10-26T04:00:00Z',
      })
    ).ok,
    true,
  );
  assert.equal(
    (await h.runner('control_sky', { action: 'lines', enabled: false })).lines,
    false,
  );
  assert.equal(
    (await h.runner('control_sky', { action: 'preset', preset: 'sunset' }))
      .preset,
    'sunset',
  );
  assert.equal((await h.runner('control_sky', { action: 'status' })).ok, true);
  assert.deepEqual(
    h.calls.map((c) => c[0]),
    ['open', 'close', 'look', 'time', 'lines', 'preset', 'status'],
  );
  assert.deepEqual(h.calls[2], ['look', 'Jupiter']);
  assert.deepEqual(h.calls[3], [
    'time',
    { time: '2026-10-26T04:00:00Z', live: undefined },
  ]);
  assert.deepEqual(h.calls[4], ['lines', false]);
  assert.deepEqual(h.calls[5], ['preset', 'sunset']);
});

test('control_sky actions are case-insensitive; an unknown action throws a short token', async () => {
  const h = harness();
  assert.equal((await h.runner('control_sky', { action: 'CLOSE' })).ok, true);
  await assert.rejects(
    () => h.runner('control_sky', { action: 'rewind' }),
    /Unknown sky action: rewind/,
  );
  await assert.rejects(
    () => h.runner('control_sky', {}),
    /Unknown sky action: missing/,
  );
  await assert.rejects(
    () => h.runner('control_sky', { action: 'Bearer SECRETKEY123' }),
    /Unknown sky action: missing/,
  );
});

test('control_sky without a Sky view in this host says so', async () => {
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const dataManager = { layers: new Map(), getAll: () => [] };
  for (const sky of [undefined, () => null]) {
    const runner = createGevActionRunner({
      viewer,
      styleManager: {},
      dataManager,
      sky,
    });
    const r = await runner('control_sky', { action: 'open' });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'control_sky');
    assert.match(r.error, /not available/);
  }
});

test('control_sky passes live through and does not invent a target', async () => {
  const h = harness();
  await h.runner('control_sky', { action: 'time', live: true });
  assert.deepEqual(h.calls[0], ['time', { time: undefined, live: true }]);
  await h.runner('control_sky', { action: 'look' });
  assert.deepEqual(h.calls[1], ['look', undefined]);
});

test('control_sky drives the real Sky voice adapter through the window hook shape', async () => {
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  let handle = null;
  const hook = {
    voice: createSkyVoice({ getHandle: () => handle, satelliteWaitMs: 0 }),
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    // The same expression src/app/tools.js hands the runner.
    sky: () => hook?.voice ?? null,
  });
  // No Sky mounted yet: the adapter answers, the tool does not throw.
  const none = await runner('control_sky', { action: 'status' });
  assert.equal(none.ok, false);
  assert.equal(none.action, 'control_sky');
  assert.match(none.error, /not available/);

  // A mounted Sky, as far as the adapter reads it.
  const calls = [];
  const jupiter = {
    label: 'Jupiter',
    kind: 'body',
    score: 0,
    target: { type: 'body', name: 'Jupiter' },
  };
  let timeMs = Date.parse('2026-10-26T04:00:00Z');
  const flags = { lines: true };
  handle = {
    active: false,
    observer: { latDeg: 30, lonDeg: -95 },
    clock: { mode: 'live' },
    time: { getTime: () => timeMs },
    content: {
      flags,
      marker: null,
      search: (q) => (/jupiter/i.test(q) ? [jupiter] : []),
      lookAt(hit) {
        calls.push(['lookAt', hit.label]);
        return { azDeg: 120, elDeg: 35 };
      },
      setFlags(next) {
        calls.push(['setFlags', next]);
        Object.assign(flags, next);
      },
    },
    async openHere() {
      calls.push(['openHere']);
      handle.active = true;
      return { ok: true };
    },
    setTime(ms) {
      calls.push(['setTime', ms]);
      timeMs = ms;
    },
    goLive() {
      calls.push(['goLive']);
    },
  };

  const open = await runner('control_sky', { action: 'open' });
  assert.equal(open.ok, true);
  assert.equal(open.opened, true);
  assert.equal(open.open, true);
  assert.deepEqual(calls, [['openHere']]);

  const status = await runner('control_sky', { action: 'STATUS' });
  assert.equal(status.ok, true);
  assert.equal(status.time, '2026-10-26T04:00:00.000Z');
  assert.equal(status.lines, true);

  const looked = await runner('control_sky', {
    action: 'look',
    target: 'Jupiter',
  });
  assert.equal(looked.ok, true);
  assert.equal(looked.target, 'Jupiter');
  assert.equal(looked.elevationDeg, 35);
  assert.equal(looked.belowHorizon, false);
  assert.deepEqual(calls.at(-1), ['lookAt', 'Jupiter']);

  const nothing = await runner('control_sky', {
    action: 'look',
    target: 'nothing like that',
  });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.action, 'control_sky');
  assert.doesNotMatch(nothing.error, /nothing like that/);

  const off = await runner('control_sky', { action: 'lines', enabled: false });
  assert.equal(off.ok, true);
  assert.equal(off.lines, false);
  assert.deepEqual(calls.at(-1), ['setFlags', { lines: false }]);

  const noZone = await runner('control_sky', {
    action: 'time',
    time: '2026-10-26T05:00:00',
  });
  assert.equal(noZone.ok, false);
  assert.match(noZone.error, /zone/);
  const moved = await runner('control_sky', {
    action: 'time',
    time: '2026-10-26T05:00:00-06:00',
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(calls.at(-1), [
    'setTime',
    Date.parse('2026-10-26T11:00:00Z'),
  ]);

  const live = await runner('control_sky', {
    action: 'time',
    live: true,
    time: '2026-10-26T05:00:00Z',
  });
  assert.equal(live.ok, true);
  assert.equal(live.live, true);
  assert.deepEqual(calls.at(-1), ['goLive']);
});
