// The outbox (server/lineupOutbox.js): settled lineups queue locally first, then ride the SAME dedicated
// data channel as lineupPublish (dated keys under packs/lineup-library/). Offline they accumulate and resume.
// Feature-off (SP_LINEUP_OUTBOX=0) must change nothing: no file, no publish call, no throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enqueueOutbox, createLineupOutbox, outboxEnabled, OUTBOX_NAME,
} from '../server/lineupOutbox.js';

function tempDir() { return mkdtempSync(join(tmpdir(), 'lineup-outbox-')); }
const cells = () => ([{ id: 'a', golden: false, row: 9, col: 3, dir: 'UP' }, { id: 'b', golden: false, row: 9, col: 4, dir: 'LEFT' }]);
const rec = (sig = 'sig-1', modeId = 'coop') => ({ t: 'lineup', at: '2026-10-18T00:00:00Z', modeId, stageId: 's1', difficulty: 'HARD', round: 3, sig, cells: cells() });

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const quiet = { warn() {}, info() {}, error() {} };

test('feature off (SP_LINEUP_OUTBOX=0): enqueue does nothing — no file, no throw', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: '0' }, async () => {
      assert.equal(outboxEnabled(), false);
      await enqueueOutbox(dir, [rec()], { mid: 'm1' });
      assert.equal(existsSync(join(dir, OUTBOX_NAME)), false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a queued batch lands in outbox.jsonl with the envelope fields', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: null }, async () => {
      await enqueueOutbox(dir, [rec('sig-1'), rec('sig-2')], { mid: 'battle-9', outcome: { victory: true, reason: 'victory' } });
      const lines = readFileSync(join(dir, OUTBOX_NAME), 'utf8').split('\n').filter(Boolean);
      assert.equal(lines.length, 2);
      const doc = JSON.parse(lines[0]);
      assert.equal(doc.mid, 'battle-9');
      assert.deepEqual(doc.outcome, { victory: true, reason: 'victory' });
      assert.equal(doc.sig, 'sig-1');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a successful publish confirms and clears exactly those lines', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: null }, async () => {
      await enqueueOutbox(dir, [rec('sig-1'), rec('sig-2')], { mid: 'm' });
      const calls = [];
      const publish = async ({ key, records }) => { calls.push({ key, n: records.length }); return { ok: true, status: 200 }; };
      const ob = createLineupOutbox({ dir, publish, log: quiet });
      await ob.syncOnce();
      assert.deepEqual(calls, [{ key: 'coop__HARD', n: 2 }]);
      assert.equal(ob.state().sent, 2);
      assert.equal(existsSync(join(dir, OUTBOX_NAME)), false, 'confirmed lines are gone');
      ob.stop();
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('409 (today\'s key already taken) DEFERS the batch — the lines stay queued for the next UTC day', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: null }, async () => {
      await enqueueOutbox(dir, [rec('sig-1')], {});
      const ob = createLineupOutbox({ dir, publish: async () => ({ ok: true, status: 409, reason: '已发布过（只增不改）' }), log: quiet });
      await ob.syncOnce();
      // 409 is not a receipt: this batch was never uploaded, so dropping it would lose data.
      assert.equal(ob.state().sent, 0);
      assert.equal(ob.state().failures, 0, 'a taken slot is not a failure — it is a schedule');
      assert.match(ob.state().error, /next UTC day/);
      assert.equal(readFileSync(join(dir, OUTBOX_NAME), 'utf8').split('\n').filter(Boolean).length, 1);
      // and the retry is parked until after the next midnight, not a 15-minute hammer
      await ob.syncOnce();
      assert.equal(ob.state().ticks, 1, 'the second call is inside the deferral window');
      ob.stop();
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline: a failed publish keeps the backlog, the retry drains it (优先到本地，连不上则下次)', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: null }, async () => {
      await enqueueOutbox(dir, [rec('sig-1')], { mid: 'm' });
      let up = false;
      const publish = async () => { if (!up) throw new Error('ECONNREFUSED'); return { ok: true, status: 200 }; };
      const ob = createLineupOutbox({ dir, publish, log: quiet });
      await ob.syncOnce();
      assert.equal(ob.state().failures, 1);
      assert.equal(readFileSync(join(dir, OUTBOX_NAME), 'utf8').split('\n').filter(Boolean).length, 1, 'the backlog survives');
      up = true;
      const ob2 = createLineupOutbox({ dir, publish, log: quiet });
      await ob2.syncOnce();
      assert.equal(ob2.state().sent, 1);
      assert.equal(existsSync(join(dir, OUTBOX_NAME)), false);
      ob.stop(); ob2.stop();
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a non-ok answer holds that mode\'s records (a 403 keeps them for tomorrow)', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: null }, async () => {
      await enqueueOutbox(dir, [rec('sig-1')], { mid: 'm' });
      const ob = createLineupOutbox({ dir, publish: async () => ({ ok: false, status: 403, reason: 'begin 被拒' }), log: quiet });
      await ob.syncOnce();
      assert.equal(ob.state().failures, 1);
      assert.equal(readFileSync(join(dir, OUTBOX_NAME), 'utf8').split('\n').filter(Boolean).length, 1);
      ob.stop();
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('per-mode grouping: each mode publishes separately; a failing mode does not block a good one', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: null }, async () => {
      await enqueueOutbox(dir, [rec('s1', 'mode_a'), rec('s2', 'mode_a'), rec('s3', 'mode_b')], {});
      const seen = [];
      const publish = async ({ key, records }) => {
        seen.push([key, records.length]);
        return key === 'mode_a__HARD' ? { ok: true, status: 200 } : { ok: false, status: 403 };
      };
      const ob = createLineupOutbox({ dir, publish, log: quiet });
      await ob.syncOnce();
      assert.deepEqual(seen.sort(), [['mode_a__HARD', 2], ['mode_b__HARD', 1]]);
      const left = readFileSync(join(dir, OUTBOX_NAME), 'utf8').split('\n').filter(Boolean);
      assert.equal(left.length, 1, 'only the failed mode stays queued');
      assert.ok(left[0].includes('"mode_b"'));
      ob.stop();
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt lines are cleared without blocking the valid ones', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: null }, async () => {
      writeFileSync(join(dir, OUTBOX_NAME), `not json at all\n${JSON.stringify({ ...rec('good'), mid: null, outcome: null })}\n`, 'utf8');
      const seen = [];
      const publish = async ({ key, records }) => { seen.push({ key, n: records.length }); return { ok: true, status: 200 }; };
      const ob = createLineupOutbox({ dir, publish, log: quiet });
      await ob.syncOnce();
      assert.deepEqual(seen, [{ key: 'coop__HARD', n: 1 }]);
      assert.equal(existsSync(join(dir, OUTBOX_NAME)), false, 'the corrupt line got cleaned with the batch');
      ob.stop();
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a backlog of only corrupt lines is cleared without a publish call', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: null }, async () => {
      writeFileSync(join(dir, OUTBOX_NAME), 'garbage\n', 'utf8');
      let called = 0;
      const ob = createLineupOutbox({ dir, publish: async () => { called++; return { ok: true, status: 200 }; }, log: quiet });
      await ob.syncOnce();
      assert.equal(called, 0);
      assert.equal(existsSync(join(dir, OUTBOX_NAME)), false);
      ob.stop();
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('requestFlush: a settle triggers an upload right away, coalesced inside the debounce window', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: null }, async () => {
      await enqueueOutbox(dir, [rec('sig-1')], { mid: 'm' });
      let calls = 0;
      const publish = async () => { calls++; return { ok: true, status: 200 }; };
      const ob = createLineupOutbox({ dir, publish, log: quiet, flushDebounceMs: 20 });
      ob.requestFlush(); ob.requestFlush(); ob.requestFlush(); // three settles burst in
      // the debounce fires on a timer and the upload itself is async: poll instead of a fixed sleep (a loaded
      // CI runner can take longer than 150 ms to get through read + publish)
      const deadline = Date.now() + 3000;
      while (!calls && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100)); // give a (wrong) second upload a chance to show up
      assert.equal(calls, 1, 'the window collapses a burst into one upload');
      assert.equal(existsSync(join(dir, OUTBOX_NAME)), false);
      ob.stop();
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the settle path asks for a flush through the hook (setLineupFlushHook)', async () => {
  const dir = tempDir();
  try {
    const { recordPrepLineups, flushMatchLineups, setLineupFlushHook } = await import('../server/lineupLibrary.js');
    await withEnv({ SP_LINEUP_LIBRARY: dir, SP_LINEUP_OUTBOX: null }, async () => {
      let flushed = 0;
      setLineupFlushHook(() => { flushed++; });
      try {
        const board = new Map([['9,3', { kind: 'chess', id: 'a', dir: 'UP' }], ['9,4', { kind: 'chess', id: 'b', dir: 'LEFT' }]]);
        const m = { modeId: 'coop', stageId: 's1', difficulty: 'HARD', round: 3, gd: { isGolden: () => false }, alivePlayers: () => [{ botControlled: false, board }] };
        recordPrepLineups(m);
        flushMatchLineups(m, { victory: true, reason: 'victory' });
        assert.equal(flushed, 1, 'a settled batch asks for an immediate flush');
        // an abandoned settlement queues nothing, so it must not ask either
        recordPrepLineups(m);
        flushMatchLineups(m, { victory: false, reason: 'abandoned' });
        assert.equal(flushed, 1);
      } finally { setLineupFlushHook(null); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the outbox cap: an over-size backlog drops its oldest quarter, not the newest', async () => {
  const dir = tempDir();
  try {
    await withEnv({ SP_LINEUP_OUTBOX: null }, async () => {
      const file = join(dir, OUTBOX_NAME);
      // start one line under MAX_OUTBOX_LINES (8000); the fresh enqueue crosses it and trims to the newest 75%.
      writeFileSync(file, `${Array.from({ length: 8000 }, (_, i) => JSON.stringify({ ...rec(`k${i}`), mid: null, outcome: null })).join('\n')}\n`, 'utf8');
      await enqueueOutbox(dir, [rec('newest')], {});
      const after = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      assert.equal(after.length, 6001, `over-cap trim should keep the newest 75%, got ${after.length}`);
      assert.ok(after.some((l) => l.includes('"newest"')), 'the fresh line survives');
      assert.ok(after.some((l) => l.includes('"k7999"')), 'the recent lines survive');
      assert.ok(!after.some((l) => /"k0"/.test(l)), 'the oldest line is gone');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('end-to-end: a settled match (flushMatchLineups) queues the outbox next to the library', async () => {
  const dir = tempDir();
  try {
    const { recordPrepLineups, flushMatchLineups } = await import('../server/lineupLibrary.js');
    await withEnv({ SP_LINEUP_LIBRARY: dir, SP_LINEUP_OUTBOX: null }, async () => {
      const board = new Map([['9,3', { kind: 'chess', id: 'a', dir: 'UP' }], ['9,4', { kind: 'chess', id: 'b', dir: 'LEFT' }]]);
      const m = {
        modeId: 'coop', stageId: 's1', difficulty: 'HARD', round: 3, battlePrefix: 'bp-7',
        gd: { isGolden: () => false },
        alivePlayers: () => [{ botControlled: false, board }],
      };
      recordPrepLineups(m);
      flushMatchLineups(m, { victory: true, reason: 'victory' });
      await new Promise((r) => setTimeout(r, 150)); // both the library append and the queue are fire-and-forget
      assert.ok(existsSync(join(dir, 'lineups_coop__HARD.jsonl')), 'the local library kept its line');
      const queued = readFileSync(join(dir, OUTBOX_NAME), 'utf8').split('\n').filter(Boolean);
      assert.equal(queued.length, 1);
      assert.equal(JSON.parse(queued[0]).mid, 'bp-7');
      assert.equal(JSON.parse(queued[0]).outcome.reason, 'victory');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an abandoned settlement queues nothing (the outcome gate comes before the queue)', async () => {
  const dir = tempDir();
  try {
    const { recordPrepLineups, flushMatchLineups } = await import('../server/lineupLibrary.js');
    await withEnv({ SP_LINEUP_LIBRARY: dir, SP_LINEUP_OUTBOX: null }, async () => {
      const board = new Map([['9,3', { kind: 'chess', id: 'a', dir: 'UP' }], ['9,4', { kind: 'chess', id: 'b', dir: 'LEFT' }]]);
      const m = { modeId: 'coop', stageId: 's1', difficulty: 'HARD', round: 3, gd: { isGolden: () => false }, alivePlayers: () => [{ botControlled: false, board }] };
      recordPrepLineups(m);
      flushMatchLineups(m, { victory: false, reason: 'abandoned' });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(existsSync(join(dir, OUTBOX_NAME)), false);
      assert.equal(existsSync(join(dir, 'lineups_coop__HARD.jsonl')), false, 'the library gate is unchanged');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
