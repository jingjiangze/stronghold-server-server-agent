// tools/migrate-lineups.mjs: the old per-mode library splits into per-mode+per-difficulty files.
// Dry-run writes nothing; --apply writes one file per difficulty and renames the old one; a second run is a no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../tools/migrate-lineups.mjs';

const row = (diff, sig) => JSON.stringify({
  t: 'lineup', at: '2026-10-18T00:00:00Z', modeId: 'mode_single_hard', stageId: 's',
  difficulty: diff, round: 3, sig,
  cells: [{ id: 'a', golden: false, row: 9, col: 3, dir: 'UP' }, { id: 'b', golden: false, row: 9, col: 4, dir: 'LEFT' }],
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-mig-'));
  writeFileSync(join(dir, 'lineups_mode_single_hard.jsonl'), `${[row('HARD', 'h1'), row('NORMAL', 'n1'), row('HARD', 'h2')].join('\n')}\n`);
  return dir;
}

test('dry-run reports the split and writes nothing', () => {
  const dir = fixture();
  try {
    const rep = migrate(dir, { apply: false, log: () => {} });
    assert.equal(rep.files, 1);
    assert.equal(rep.rows, 3);
    assert.equal(rep.groups, 2);
    assert.ok(existsSync(join(dir, 'lineups_mode_single_hard.jsonl')), 'the old file is untouched');
    assert.ok(!existsSync(join(dir, 'lineups_mode_single_hard__HARD.jsonl')));
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('--apply splits by difficulty and renames the old file; a second run is a no-op', () => {
  const dir = fixture();
  try {
    const rep = migrate(dir, { apply: true, log: () => {} });
    assert.equal(rep.groups, 2);
    assert.deepEqual(rep.errors, []);
    const hard = readFileSync(join(dir, 'lineups_mode_single_hard__HARD.jsonl'), 'utf8').trim().split('\n');
    const normal = readFileSync(join(dir, 'lineups_mode_single_hard__NORMAL.jsonl'), 'utf8').trim().split('\n');
    assert.equal(hard.length, 2);
    assert.equal(normal.length, 1);
    assert.deepEqual(hard.map((l) => JSON.parse(l).sig), ['h1', 'h2']);
    assert.ok(existsSync(join(dir, 'lineups_mode_single_hard.jsonl.migrated')), 'the old file is kept for checking');
    assert.ok(!existsSync(join(dir, 'lineups_mode_single_hard.jsonl')));
    const again = migrate(dir, { apply: true, log: () => {} });
    assert.equal(again.files, 0, 'nothing left to migrate');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('an existing new-layout file is appended to, never overwritten', () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, 'lineups_mode_single_hard__HARD.jsonl'), `${row('HARD', 'pre')}\n`);
    migrate(dir, { apply: true, log: () => {} });
    const hard = readFileSync(join(dir, 'lineups_mode_single_hard__HARD.jsonl'), 'utf8').trim().split('\n');
    assert.deepEqual(hard.map((l) => JSON.parse(l).sig), ['pre', 'h1', 'h2']);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
