// tools/lineups-aggregate.mjs: R2 的日期文件（只增不改的历史）聚合成每库一份去重语料。
// 口径必须与写库端一致：sig 去重、坏行丢弃、--since 过日期、--max-lines 保留最新。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, parseName, sigOf } from '../tools/lineups-aggregate.mjs';
import { lineupFeatures } from '../shared/lineupFeatures.mjs';

const cells = (col = 3) => ([
  { id: 'a', golden: false, row: 9, col, dir: 'UP' },
  { id: 'b', golden: false, row: 9, col: col + 1, dir: 'LEFT' },
]);
const row = (sig, col = 3) => JSON.stringify({
  t: 'lineup', at: '2026-10-18T00:00:00Z', modeId: 'mode_single_hard', stageId: 's', difficulty: 'HARD', round: 3, sig, cells: cells(col),
});

test('parseName understands both the dated key and the merged name', () => {
  assert.deepEqual(parseName('mode_single_hard__HARD-2026-10-18.jsonl'), { key: 'mode_single_hard__HARD', date: '2026-10-18' });
  assert.deepEqual(parseName('lineups_mode_single_hard__HARD.jsonl'), { key: 'mode_single_hard__HARD', date: null });
  assert.equal(parseName('notes.txt'), null);
  assert.equal(parseName('lineups_x.jsonl.bak'), null);
});

test('aggregates dated files into one deduped library, newest kept under --max-lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'lineup-agg-'));
  try {
    const inA = join(root, 'day1');
    const inB = join(root, 'day2');
    mkdirSync(inA); mkdirSync(inB);
    writeFileSync(join(inA, 'mode_single_hard__HARD-2026-10-17.jsonl'), `${row('s1')}\n${row('s2', 5)}\n`);
    writeFileSync(join(inB, 'mode_single_hard__HARD-2026-10-18.jsonl'), `${row('s2', 5)}\n${row('s3', 7)}\n`);
    // a different library stays separate; a broken line is counted, never written
    writeFileSync(join(inB, 'mode_multi_hard__HARD-2026-10-18.jsonl'), `${row('m1')}\nnot json\n`);
    const out = join(root, 'out');
    const rep = aggregate([root], { out, log: () => {} });
    assert.equal(rep.files, 3);
    assert.equal(rep.rowsIn, 6); // 2 + 2 + (1 valid + 1 broken)
    assert.equal(rep.dupes, 1, 's2 appears on both days');
    assert.equal(rep.invalid, 1);
    assert.equal(rep.rowsOut, 4);
    const merged = readFileSync(join(out, 'lineups_mode_single_hard__HARD.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(merged.map((r) => r.sig).sort(), ['s1', 's2', 's3']);
    assert.ok(existsSync(join(out, 'lineups_mode_multi_hard__HARD.jsonl')), 'each library gets its own file');
    const stats = JSON.parse(readFileSync(join(out, 'stats.json'), 'utf8'));
    assert.equal(stats.keys['mode_single_hard__HARD'].rows, 3);
    assert.equal(stats.keys['mode_single_hard__HARD'].features.count, 3, 'features are summarized per library');
    assert.equal(stats.keys['mode_multi_hard__HARD'].rows, 1);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('--since drops older dated files; --max-lines keeps the newest rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'lineup-agg-'));
  try {
    writeFileSync(join(root, 'mode_single_hard__HARD-2026-09-01.jsonl'), `${row('old')}\n`);
    writeFileSync(join(root, 'mode_single_hard__HARD-2026-10-18.jsonl'), `${row('a1')}\n${row('a2', 5)}\n${row('a3', 7)}\n`);
    const rep = aggregate([root], { since: '2026-10-01', maxLines: 2, log: () => {} });
    assert.equal(rep.rowsOut, 2, 'only two of the three rows survive --max-lines');
    assert.equal(rep.keys['mode_single_hard__HARD'].rows, 2);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('sigOf matches the server-side signature (sort of id:golden:row:col:dir)', () => {
  assert.equal(sigOf(cells(3)), 'a:0:9:3:UP|b:0:9:4:LEFT');
  assert.equal(sigOf([...cells(3)].reverse()), sigOf(cells(3)), 'order does not matter');
});

test('lineupFeatures: a malformed board yields null, a real one yields the geometric summary', () => {
  assert.equal(lineupFeatures([]), null);
  assert.equal(lineupFeatures([{ id: 'x' }]), null, 'no coordinates → no numbers invented');
  const f = lineupFeatures(cells(3), { rows: 10, cols: 8 });
  assert.equal(f.n, 2);
  assert.equal(f.colSpread, 1);
  assert.equal(typeof f.centroidDist, 'number');
  assert.equal(f.facings.UP, 1);
  assert.equal(f.facings.LEFT, 1);
});
