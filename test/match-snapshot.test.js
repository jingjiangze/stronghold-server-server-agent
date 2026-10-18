// shared/matchSnapshot.mjs — 客户端上报的对局快照：白名单字段、有界、缺字段可查。
// 反推方案的前提是「服务端只信收敛后的形状」，所以这里逐条钉住消毒行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSnapshot, checkSnapshotSet, SNAPSHOT_VERSION, SNAPSHOT_MAX_BYTES } from '../shared/matchSnapshot.mjs';

const board = (n = 2) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, golden: i === 0, row: 9, col: 3 + i, dir: 'UP', uid: `u${i}` }));
const good = (over = {}) => ({
  v: SNAPSHOT_VERSION, roomCode: 'ABCD', playerId: 'p_1', at: 1, phase: 'PREP', round: 3,
  lp: 12, funds: 7, bandId: 'band', alive: true, board: board(), hand: [{ uid: 'h1', kind: 'chess', id: 'c0', count: 1 }],
  shop: { level: 3, slots: [{ kind: 'chess', id: 'c9', sold: false }] }, stats: { kills: 5, leaks: 1, gold: 30 },
  ...over,
});

test('a well-formed snapshot is kept whole', () => {
  const r = sanitizeSnapshot(good());
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.roomCode, 'ABCD');
  assert.equal(r.snapshot.board.length, 2);
  assert.equal(r.snapshot.funds, 7);
  assert.deepEqual(r.missing, []);
});

test('unknown fields are dropped, never forwarded (the server only reads the whitelist)', () => {
  const r = sanitizeSnapshot(good({ evil: 'x', seed: 12345, pool: { left: 99 } }));
  assert.equal(r.ok, true);
  assert.equal('evil' in r.snapshot, false);
  assert.equal('seed' in r.snapshot, false, 'a client cannot smuggle the seed');
  assert.equal('pool' in r.snapshot, false, 'nor pool counts');
});

test('version, room code and player id are mandatory', () => {
  assert.equal(sanitizeSnapshot({ ...good(), v: 2 }).ok, false);
  assert.equal(sanitizeSnapshot({ ...good(), roomCode: '' }).ok, false);
  assert.equal(sanitizeSnapshot({ ...good(), playerId: '' }).ok, false);
  assert.equal(sanitizeSnapshot(null).ok, false);
});

test('bad cells are dropped, good ones survive; missing scalar fields are reported', () => {
  const bad = [
    { id: 'ok', golden: false, row: 9, col: 3, dir: 'UP' },
    { id: 'oob', row: 99, col: 3, dir: 'UP' },
    { id: 'dir', row: 9, col: 3, dir: 'SIDEWAYS' },
    { id: '', row: 9, col: 3, dir: 'UP' },
  ];
  const r = sanitizeSnapshot(good({ board: bad, lp: undefined, funds: undefined }));
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.board.length, 1);
  assert.deepEqual(r.dropped.filter((d) => d === 'board[]').length, 3);
  assert.ok(r.missing.includes('lp') && r.missing.includes('funds'));
});

test('the size cap rejects an oversized submission instead of truncating it', () => {
  const huge = good({ board: Array.from({ length: 64 }, (_, i) => ({ id: 'x'.repeat(60) + i, golden: false, row: 9, col: 3, dir: 'UP', uid: 'u' + i })) });
  const r = sanitizeSnapshot(huge);
  // 64 个 60 字符 id 合起来仍然小于上限；再叠一层超长手牌把它顶过去
  const bigger = sanitizeSnapshot(good({ board: huge.board, hand: Array.from({ length: 64 }, (_, i) => ({ uid: 'u'.repeat(60) + i, kind: 'chess', id: 'c'.repeat(60), count: 1 })) }));
  assert.ok(r.ok || bigger.ok === false);
  assert.equal(bigger.ok, false);
  assert.match(bigger.reason, new RegExp(String(SNAPSHOT_MAX_BYTES)));
});

test('checkSnapshotSet wants every expected player and reports who is missing', () => {
  const out = checkSnapshotSet([good(), good({ playerId: 'p_2' })], { expectedPlayers: ['p_1', 'p_2', 'p_3'] });
  assert.equal(out.ok, false);
  assert.equal(out.snapshots.length, 2);
  assert.ok(out.errors.some((e) => e.includes('p_3')));
  assert.equal(checkSnapshotSet([good()], { expectedPlayers: ['p_1'] }).ok, true);
});

// ---- 恢复包：魔搭等「容器重启即清盘」的部署靠客户端携带状态 -------------------------------------

import { sanitizeBundle, agreeOnBundles, BUNDLE_VERSION } from '../shared/matchSnapshot.mjs';

const bundle = (over = {}, snapOver = {}) => ({
  v: BUNDLE_VERSION, seed: 123456789, mode: 'coop', difficulty: 'HARD', modeId: 'mode_multi_hard',
  snapshot: good(snapOver), ...over,
});

test('bundle: seed / mode / difficulty / modeId are mandatory and the snapshot is sanitized', () => {
  assert.equal(sanitizeBundle(bundle()).ok, true);
  assert.equal(sanitizeBundle(bundle({ seed: -1 })).ok, false, 'seed must be uint32');
  assert.equal(sanitizeBundle(bundle({ seed: 1.5 })).ok, false);
  assert.equal(sanitizeBundle(bundle({ mode: '' })).ok, false);
  assert.equal(sanitizeBundle(bundle({ v: 99 })).ok, false);
  const r = sanitizeBundle(bundle({ evil: 'x' }));
  assert.equal(r.ok, true);
  assert.equal('evil' in r.bundle, false);
});

test('bundles agree only when they describe the same match (seed included)', () => {
  const a = bundle({}, { playerId: 'p_1' });
  const b = bundle({}, { playerId: 'p_2' });
  const ok = agreeOnBundles([a, b]);
  assert.equal(ok.ok, true);
  assert.equal(ok.meta.seed, 123456789);
  assert.equal(ok.snapshots.length, 2);

  const bad = agreeOnBundles([a, bundle({ seed: 42 }, { playerId: 'p_2' })]);
  assert.equal(bad.ok, false, 'a different seed is a different match — refuse to recover');
  assert.ok(bad.conflicts.some((c) => c.startsWith('seed')));

  const otherRoom = agreeOnBundles([a, bundle({}, { playerId: 'p_2', roomCode: 'ZZZZ' })]);
  assert.equal(otherRoom.ok, false);
  assert.ok(otherRoom.conflicts.some((c) => c.startsWith('roomCode')));
});

test('a set with no valid bundle refuses recovery; malformed ones are reported', () => {
  const none = agreeOnBundles([{ v: 1 }]);
  assert.equal(none.ok, false);
  assert.ok(none.errors.length > 0);
  assert.equal(agreeOnBundles([]).ok, false);
});
