// The remote read path for the lineup library (server/lineupSync.js + the remote: branch of
// server/lineupLibrary.js): a read-only remote is pulled into a local cache, and lineupLibrary then reads that
// cache through its normal local-file path. The sync layer must fail soft — a remote that cannot be reached only
// means the AI falls back to its default layouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRemoteSpec, remoteCacheFile, fetchFirstText, createLineupSync } from '../server/lineupSync.js';
import { lineupFile, lineupDir, lineupIsSplit, lineupRemoteSpec, humanPlans } from '../server/lineupLibrary.js';

const line = (cells) => JSON.stringify({ t: 'lineup', at: 'now', modeId: 'mode_single_hard', stageId: 'act1_m01', difficulty: 'HARD', round: 3, sig: 's', cells });
const twoCells = () => [{ id: 'char_a', golden: false, row: 9, col: 3, dir: 'UP' }, { id: 'char_b', golden: false, row: 9, col: 4, dir: 'LEFT' }];

test('a remote spec is parsed into urls + cache dir; a local path is not a remote spec', () => {
  const spec = parseRemoteSpec('remote:https://a.example/lib,https://b.example/lib|/var/lib/lineups');
  assert.deepEqual(spec, {
    urls: ['https://a.example/lib', 'https://b.example/lib'],
    cacheDir: '/var/lib/lineups',
  });
  assert.equal(parseRemoteSpec('remote:only-urls'), null, 'no cache dir means nowhere to put the bytes');
  assert.equal(parseRemoteSpec('/var/lib/lineups'), null, 'a plain path is the local layout');
  assert.equal(parseRemoteSpec(''), null);
  assert.equal(parseRemoteSpec(null), null);
});

test('a remote library resolves to a LOCAL cache path, never to the URI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-remote-'));
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = `remote:https://ghfast.example/owner/repo/main|${join(dir, 'cache')}`;
  try {
    assert.equal(lineupRemoteSpec().cacheDir, join(dir, 'cache'));
    assert.equal(lineupFile('mode_single_hard', 'HARD'), join(dir, 'cache', 'lineups_mode_single_hard__HARD.jsonl'));
    // the URI must never be handed to the filesystem: no junk directory named after it
    assert.ok(!existsSync(join(dir, 'cache', 'https:')) && !existsSync('https:'), 'no directory created from the URI');
    assert.equal(lineupDir(), join(dir, 'cache'));
    assert.equal(lineupIsSplit(), true, 'a remote library is per-mode by construction');
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('fetchFirstText returns the first source that answers; a failing source is skipped, not fatal', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://down.example')) throw new Error('ECONNRESET');
    if (url.startsWith('https://slow.example')) return { ok: false, status: 503 };
    return { ok: true, status: 200, headers: { get: (k) => (k === 'etag' ? '"v1"' : null) }, text: async () => line(twoCells()) };
  };
  const out = await fetchFirstText(['https://down.example/lib/x.jsonl', 'https://slow.example/lib/x.jsonl', 'https://ok.example/lib/x.jsonl'], { fetchImpl });
  assert.equal(out.url, 'https://ok.example/lib/x.jsonl');
  assert.equal(out.etag, '"v1"');
  assert.equal(out.notModified, false);
  assert.equal(calls.length, 3, 'both failing sources were tried before the good one');

  // a 304 short-circuits with no body
  const notMod = await fetchFirstText(['https://ok.example/lib/x.jsonl'], {
    fetchImpl: async () => ({ ok: false, status: 304, headers: { get: () => null } }), etag: '"v1"',
  });
  assert.equal(notMod.notModified, true);
  assert.equal(notMod.text, '');

  // every source down → throws (the caller only logs it)
  await assert.rejects(() => fetchFirstText(['https://a.example/x'], { fetchImpl: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
});

test('the syncer writes the pulled bytes atomically and a second pull with the same etag is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-sync-'));
  const cacheDir = join(dir, 'cache');
  let served = 0;
  const fetchImpl = async () => {
    served++;
    return { ok: true, status: 200, headers: { get: (k) => (k === 'etag' ? '"e1"' : null) }, text: async () => line(twoCells()) + '\n' };
  };
  try {
    const spec = { urls: ['https://ok.example/lib'], cacheDir };
    const sync = createLineupSync({ spec, keys: ['mode_single_hard__HARD'], fetchImpl, log: { warn() {} } });
    await sync.syncOnce();
    const dest = remoteCacheFile(cacheDir, 'mode_single_hard__HARD');
    assert.ok(existsSync(dest), 'the pulled bytes are on disk');
    assert.equal(readFileSync(dest, 'utf8'), line(twoCells()) + '\n');
    assert.equal(sync.state().pulls, 1);
    // nothing half-written is left behind
    assert.ok(!existsSync(dest + '.partial'), 'the temp file was renamed away');

    // the same etag ⇒ 304 ⇒ no rewrite (the syncer must not churn the cache every interval)
    const etagFetch = async (url, opts) => {
      assert.equal(opts.headers['if-none-match'], '"e1"', 'the remembered etag is sent back');
      return { ok: false, status: 304, headers: { get: () => null } };
    };
    const second = createLineupSync({ spec, keys: ['mode_single_hard__HARD'], fetchImpl: etagFetch, log: { warn() {} } });
    await second.syncOnce();
    assert.equal(second.state().pulls, 0, 'an unchanged remote is not re-written');
    assert.equal(readFileSync(dest, 'utf8'), line(twoCells()) + '\n', 'the cache is untouched');
    assert.equal(served, 1, 'the first pull was the only full download');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a remote that cannot be reached only logs and backs off — nothing is written, nothing throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-sync-'));
  const cacheDir = join(dir, 'cache');
  const warnings = [];
  let clock = 1_000_000;
  let attempts = 0;
  try {
    const sync = createLineupSync({
      spec: { urls: ['https://down.example/lib'], cacheDir }, keys: ['mode_single_hard__HARD'],
      fetchImpl: async () => { attempts++; throw new Error('ECONNRESET'); },
      log: { warn: (m) => warnings.push(m) },
      now: () => clock,
    });
    await sync.syncOnce();
    assert.equal(sync.state().failures, 1);
    assert.match(sync.state().error, /ECONNRESET/);
    assert.ok(warnings.some((w) => w.includes('backoff')), 'the failure is reported, not swallowed');
    assert.ok(!existsSync(cacheDir), 'a failed pull leaves no cache directory at all');

    // inside the backoff window the next tick is a no-op: no fetch, no state change
    await sync.syncOnce();
    assert.equal(attempts, 1, 'still only the first attempt');
    assert.equal(sync.state().ticks, 1, 'and the tick did not run');

    // past the backoff it retries (a remote that is down for an hour must come back on its own)
    clock += 7 * 60 * 60 * 1000;
    await sync.syncOnce();
    assert.equal(attempts, 2, 'the backoff expired and it tried again');
    assert.equal(sync.state().failures, 2);
    assert.ok(!existsSync(cacheDir), 'and still nothing written');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a pulled remote library is read back through the normal local path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-remote-read-'));
  const cacheDir = join(dir, 'cache');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = `remote:https://ok.example/lib|${cacheDir}`;
  try {
    const sync = createLineupSync({
      spec: { urls: ['https://ok.example/lib'], cacheDir }, keys: ['mode_single_hard__HARD'],
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => line(twoCells()) + '\n' }),
      log: { warn() {} },
    });
    await sync.syncOnce();
    // the bot side knows nothing about the remote: it asks the library for its mode and gets the mapped plan
    const plans = humanPlans({ modeId: 'mode_single_hard', stageId: 'act1_m01', difficulty: 'HARD', round: 3 },
      [{ uid: 'u1', id: 'char_a' }, { uid: 'u2', id: 'char_b' }]);
    assert.equal(plans.length, 1, 'the pulled lineup is offered to the bot');
    assert.equal(plans[0].get('u1'), '9,3');
    // and another mode's file simply does not exist yet: no cross-talk
    assert.deepEqual(humanPlans({ modeId: 'mode_multi_hard', stageId: 'act1_m01', difficulty: 'HARD', round: 3 },
      [{ uid: 'u1', id: 'char_a' }]), []);
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
