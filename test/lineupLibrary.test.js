// The human-lineup library the AI learns from (server/lineupLibrary.js, SP_LINEUP_LIBRARY): recording a prep's human
// boards to the JSONL file, dedupe, and mapping a recorded lineup onto the pieces a bot actually drew this match.
// Feature off (no env) must change nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordPrepLineups, flushMatchLineups, dropStagedLineups, humanPlans, lineupFile, lineupDir, lineupModes,
  lineupIsSplit, reloadLibrary,
} from '../server/lineupLibrary.js';

function fakeMatch({ modeId = 'coop', stageId = 'act1_m01', difficulty = 'HARD', round = 3, seats = [] } = {}) {
  const players = seats.map((seat) => ({ botControlled: seat.bot, board: seat.board }));
  return {
    modeId,
    stageId,
    difficulty,
    round,
    gd: { isGolden: () => false },
    alivePlayers: () => players,
  };
}

const board = (entries) => new Map(entries.map(([k, id, dir]) => [k, { kind: 'chess', id, dir }]));

test('the feature is off without SP_LINEUP_LIBRARY: nothing recorded, nothing learned', () => {
  const old = process.env.SP_LINEUP_LIBRARY;
  delete process.env.SP_LINEUP_LIBRARY;
  try {
    assert.equal(lineupFile(), null);
    const m = fakeMatch({ seats: [{ bot: false, board: board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]) }] });
    recordPrepLineups(m); // must not throw and must not write anywhere
    assert.deepEqual(humanPlans(m, [{ uid: 'u1', id: 'char_a' }, { uid: 'u2', id: 'char_b' }]), []);
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
  }
});

test('a human prep is recorded once (deduped), bots are skipped, then a bot can learn the lineup back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lib.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  try {
    const human = board([
      ['9,3', 'char_a', 'UP'],
      ['9,4', 'char_b', 'LEFT'],
      ['9,5', 'token_ignored', 'DOWN'], // non-chess: skipped by the recorder
    ]);
    human.get('9,5').kind = 'token';
    const bot = board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]);
    const m = fakeMatch({ seats: [{ bot: false, board: human }, { bot: true, board: bot }] });
    recordPrepLineups(m);
    recordPrepLineups(m); // the same lineup twice: one line
    flushMatchLineups(m); // the match settled: the staged lineups are written
    await new Promise((r) => setTimeout(r, 30)); // the append is fire-and-forget
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, `one line, got ${lines.length}`);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.t, 'lineup');
    assert.equal(rec.stageId, 'act1_m01');
    assert.equal(rec.difficulty, 'HARD');
    assert.equal(rec.round, 3);
    assert.equal(rec.cells.length, 2, 'the token was not recorded');
    assert.deepEqual(rec.cells.find((c) => c.id === 'char_a'), { id: 'char_a', golden: false, row: 9, col: 3, dir: 'UP' });

    // the bot draws the same pieces (different uids — uids reset every match) and gets a mapped plan back
    const chosen = [{ uid: 'u7', id: 'char_b' }, { uid: 'u9', id: 'char_a' }];
    const plans = humanPlans(fakeMatch(), chosen);
    assert.equal(plans.length, 1);
    const plan = plans[0];
    assert.ok(plan instanceof Map);
    assert.equal(plan.get('u9'), '9,3', 'char_a mapped to the recorded tile by piece id');
    assert.equal(plan.get('u7'), '9,4');
    assert.equal(plan.dirs.get('u9'), 'UP', 'facing replays as recorded');
    assert.equal(plan.dirs.get('u7'), 'LEFT');
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recorded pieces the bot did not draw are dropped; a lineup mapping fewer than two pieces is not offered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lib.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  try {
    appendFileSync(file, JSON.stringify({
      t: 'lineup', at: 'now', modeId: 'coop', stageId: 'act1_m01', difficulty: 'HARD', round: 3,
      cells: [
        { id: 'char_a', golden: false, row: 9, col: 3, dir: 'UP' },
        { id: 'char_only_human_had', golden: false, row: 9, col: 4, dir: 'LEFT' },
      ],
    }) + '\n');
    appendFileSync(file, JSON.stringify({
      t: 'lineup', at: 'now', modeId: 'coop', stageId: 'act1_m01', difficulty: 'HARD', round: 3,
      cells: [{ id: 'another_unknown', golden: false, row: 9, col: 5, dir: 'DOWN' }],
    }) + '\n');
    appendFileSync(file, 'not json at all\n'); // a corrupt line is skipped, not fatal
    const plans = humanPlans(fakeMatch(), [{ uid: 'u1', id: 'char_a' }, { uid: 'u2', id: 'char_b' }]);
    assert.equal(plans.length, 0, 'the only fully-mappable lineup kept fewer than two pieces after the drop');
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lineups of another stage / difficulty / round are not offered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lib.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  try {
    appendFileSync(file, JSON.stringify({
      t: 'lineup', at: 'now', modeId: 'coop', stageId: 'act9_m09', difficulty: 'HARD', round: 3,
      cells: [{ id: 'char_a', golden: false, row: 9, col: 3, dir: 'UP' }, { id: 'char_b', golden: false, row: 9, col: 4, dir: 'LEFT' }],
    }) + '\n');
    const chosen = [{ uid: 'u1', id: 'char_a' }, { uid: 'u2', id: 'char_b' }];
    assert.deepEqual(humanPlans(fakeMatch(), chosen), [], 'another stage');
    assert.deepEqual(humanPlans(fakeMatch({ stageId: 'act1_m01', difficulty: 'EASY' }), chosen), [], 'another difficulty');
    assert.deepEqual(humanPlans(fakeMatch({ round: 4 }), chosen), [], 'another round');
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

// The caps are module constants, so the test drives the roll through the one knob the module exposes: a pre-seeded
// library file that is already past the cap. The first append must roll it, and the roll must keep the newest lines.
test('a library past the cap is rolled back to its newest lines on the next append', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lib.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  const line = (i) => JSON.stringify({
    t: 'lineup', at: 'now', modeId: 'coop', stageId: 'act1_m01', difficulty: 'HARD', round: 3,
    cells: [{ id: `p${i}_a`, golden: false, row: 9, col: 3, dir: 'UP' }, { id: `p${i}_b`, golden: false, row: 9, col: 4, dir: 'LEFT' }],
  });
  try {
    // 4000 distinct lineups = the MAX_LINES cap, seeded as the module would have written them
    appendFileSync(file, Array.from({ length: 4000 }, (_, i) => line(i)).join('\n') + '\n');
    assert.ok(readFileSync(file, 'utf8').includes('"p0_a"'), 'control: the seed really holds the oldest lineup');
    const m = fakeMatch({ seats: [{ bot: false, board: board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]) }] });
    recordPrepLineups(m);
    flushMatchLineups(m);
    await new Promise((r) => setTimeout(r, 50));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.ok(lines.length <= 4000, `the file must stay at or under the cap, got ${lines.length}`);
    assert.ok(lines.length >= 3600, `the roll keeps the newest 90%, got ${lines.length}`);
    assert.ok(!lines.some((l) => l.includes('"p0_a"')), 'the oldest decile is the part that goes');
    assert.ok(lines.some((l) => l.includes('"p3999_a"')), 'the newest lines survive');
    assert.ok(lines.some((l) => l.includes('"char_a"')), 'the lineup that triggered the roll is in the file');
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a library past the byte cap is rolled on the next append too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lib.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  try {
    // one huge cell array: 40 records of ~100 KiB each blows MAX_BYTES (3 MiB) long before MAX_LINES
    const cells = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, golden: false, row: 9, col: 3 + (i % 6), dir: 'UP' }));
    for (let i = 0; i < 40; i++) {
      appendFileSync(file, JSON.stringify({
        t: 'lineup', at: 'now', modeId: 'coop', stageId: 'act1_m01', difficulty: 'HARD', round: 3,
        cells: cells.map((c) => ({ ...c, id: `p${i}_${c.id}` })),
      }) + '\n');
    }
    const m = fakeMatch({ seats: [{ bot: false, board: board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]) }] });
    recordPrepLineups(m);
    flushMatchLineups(m);
    await new Promise((r) => setTimeout(r, 50));
    const bytes = statSync(file).size;
    assert.ok(bytes <= 3.5 * 1024 * 1024, `the byte cap holds, got ${bytes}`);
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SP_LINEUP_LIBRARY may name a DIRECTORY: the library becomes one file per mode+difficulty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const libDir = join(dir, 'library'); // does not exist yet — a fresh volume mount
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = libDir;
  try {
    assert.equal(lineupFile('coop', 'HARD'), join(libDir, 'lineups_coop__HARD.jsonl'), 'a directory resolves to one file per mode+difficulty');
    assert.equal(lineupFile('coop', 'NORMAL'), join(libDir, 'lineups_coop__NORMAL.jsonl'), 'the difficulty is part of the file');
    assert.equal(lineupFile('single_hard', 'HARD'), join(libDir, 'lineups_single_hard__HARD.jsonl'));
    assert.equal(lineupDir(), libDir);
    const m = fakeMatch({ seats: [{ bot: false, board: board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]) }] });
    recordPrepLineups(m);
    assert.ok(!existsSync(lineupFile('coop', 'HARD')), 'staging alone writes nothing');
    flushMatchLineups(m);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(existsSync(join(libDir, 'lineups_coop__HARD.jsonl')), 'the directory was created and holds this mode+difficulty file');
    assert.deepEqual(lineupModes(), ['coop__HARD'], 'the publisher can enumerate the library keys that have a file');
    // and the same directory can be read back by a later process (the load path resolves it identically)
    const plans = humanPlans(fakeMatch(), [{ uid: 'u1', id: 'char_a' }, { uid: 'u2', id: 'char_b' }]);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].get('u1'), '9,3');
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory keeps every mode in its own file and its own key space', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const libDir = join(dir, 'library');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = libDir;
  try {
    const coop = fakeMatch({ seats: [{ bot: false, board: board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]) }] });
    const single = fakeMatch({
      modeId: 'single_hard', stageId: 'act2_m03', difficulty: 'HARD',
      seats: [{ bot: false, board: board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]) }],
    });
    recordPrepLineups(coop);
    flushMatchLineups(coop);
    recordPrepLineups(single);
    flushMatchLineups(single);
    await new Promise((r) => setTimeout(r, 30));
    const read = (key) => readFileSync(join(libDir, `lineups_${key}.jsonl`), 'utf8').trim().split('\n');
    assert.equal(read('coop__HARD').length, 1, 'one file per mode+difficulty');
    assert.equal(read('single_hard__HARD').length, 1);
    assert.equal(JSON.parse(read('coop__HARD')[0]).modeId, 'coop');
    assert.equal(JSON.parse(read('single_hard__HARD')[0]).stageId, 'act2_m03');
    // the same pieces and stage under another mode are a different key: no cross-talk either way
    const chosen = [{ uid: 'u1', id: 'char_a' }, { uid: 'u2', id: 'char_b' }];
    assert.equal(humanPlans(coop, chosen).length, 1, 'coop keeps its own lineup');
    assert.equal(humanPlans(fakeMatch({ modeId: 'single_hard', stageId: 'act2_m03' }), chosen).length, 1);
    assert.equal(humanPlans(fakeMatch({ modeId: 'single_hard' }), chosen).length, 0, 'another mode does not borrow it');
    assert.equal(humanPlans(fakeMatch({ modeId: 'multi_hard', stageId: 'act1_m01' }), chosen).length, 0);
    assert.deepEqual(lineupModes(), ['coop__HARD', 'single_hard__HARD']);
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the single-file layout still keys everything together (the pre-split upgrade path)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lineups.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  try {
    const a = fakeMatch({ seats: [{ bot: false, board: board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]) }] });
    const b = fakeMatch({
      modeId: 'single_hard', stageId: 'act2_m03',
      seats: [{ bot: false, board: board([['9,3', 'char_c', 'UP'], ['9,4', 'char_d', 'LEFT']]) }],
    });
    recordPrepLineups(a);
    flushMatchLineups(a);
    recordPrepLineups(b);
    flushMatchLineups(b);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(lineupFile('anything'), file, 'a file path is the file, whatever the mode');
    assert.equal(lineupIsSplit(), false);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'both modes append to the one file');
    // ...and the mode stays part of the key inside it
    assert.equal(humanPlans(fakeMatch({ modeId: 'single_hard', stageId: 'act2_m03' }), [
      { uid: 'u1', id: 'char_c' }, { uid: 'u2', id: 'char_d' },
    ]).length, 1);
    assert.equal(humanPlans(fakeMatch({ stageId: 'act2_m03' }), [
      { uid: 'u1', id: 'char_c' }, { uid: 'u2', id: 'char_d' },
    ]).length, 0, 'without the mode it is a different key');
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a match that never settles records nothing; its disposal drops what it staged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lib.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  const seats = [{ bot: false, board: board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]) }];
  try {
    // 1. an abandoned match: preps ran, no finish() — the file must not exist at all
    const abandoned = fakeMatch({ seats });
    recordPrepLineups(abandoned);
    recordPrepLineups(fakeMatch({ seats })); // a second prep of the same match
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!existsSync(file), 'staged-but-unsettled lineups never reach the file');
    // 2. disposal drops the stage, so the NEXT match's records are not polluted by the dead one's
    dropStagedLineups();
    // 3. a settled match in the same process: only its own lineups land, exactly once each
    const settled = fakeMatch({ seats });
    recordPrepLineups(settled);
    flushMatchLineups(settled);
    flushMatchLineups(settled); // idempotent: the stage was already drained
    await new Promise((r) => setTimeout(r, 30));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, `only the settled match's lineup, got ${lines.length}`);
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a settlement that is not a real result publishes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lib.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  const seats = [{ bot: false, board: board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]) }];
  try {
    for (const reason of ['error', 'abandoned', 'eliminated']) {
      const m = fakeMatch({ seats });
      recordPrepLineups(m);
      flushMatchLineups(m, { victory: false, reason });
      dropStagedLineups();
    }
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!existsSync(file), `nothing was publishable, got ${existsSync(file)}`);
    // a real loss still played complete rounds, so its lineups count
    const lost = fakeMatch({ seats });
    recordPrepLineups(lost);
    flushMatchLineups(lost, { victory: false, reason: 'defeat' });
    const won = fakeMatch({ seats });
    recordPrepLineups(won);
    flushMatchLineups(won, { victory: true, reason: 'victory' });
    await new Promise((r) => setTimeout(r, 30));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'only the settled match with a usable reason is written');
    // a caller that passes no outcome (the pre-outcome call shape) still publishes
    const noOutcome = fakeMatch({ seats: [{ bot: false, board: board([['9,5', 'char_z', 'UP'], ['9,6', 'char_y', 'LEFT']]) }] });
    recordPrepLineups(noOutcome);
    flushMatchLineups(noOutcome);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lineup replayed far too often in one hour is a farm, not a player', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lib.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  // the same board, settled over and over inside the window: the farm check counts the replays, not the seats
  const farm = board([['9,3', 'farm_a', 'UP'], ['9,4', 'farm_b', 'LEFT']]);
  const once = board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]);
  try {
    for (let i = 0; i < 45; i++) {
      const m = fakeMatch({ seats: [{ bot: false, board: farm }] });
      recordPrepLineups(m);
      flushMatchLineups(m, { victory: true, reason: 'victory' });
    }
    // a different lineup in the same window is unaffected
    const m = fakeMatch({ seats: [{ bot: false, board: once }] });
    recordPrepLineups(m);
    flushMatchLineups(m, { victory: true, reason: 'victory' });
    await new Promise((r) => setTimeout(r, 40));
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const farmLines = lines.filter((l) => l.includes('farm_a'));
    // the first replays are a real player trying a real lineup; past the cap the same signature stops being written
    assert.ok(farmLines.length > 0, 'a lineup is not guilty before it repeats');
    assert.ok(farmLines.length < 45, `the farm stops at the cap, got ${farmLines.length}`);
    assert.ok(lines.some((l) => l.includes('char_a')), 'an unrelated lineup in the same window is unaffected');
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cells outside the field, or with an unknown facing, are not a lineup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lib.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  try {
    const bad = [
      [{ id: 'char_a', golden: false, row: 99, col: 3, dir: 'UP' }, { id: 'char_b', golden: false, row: 9, col: 4, dir: 'LEFT' }],
      [{ id: 'char_a', golden: false, row: 9.5, col: 3, dir: 'UP' }, { id: 'char_b', golden: false, row: 9, col: 4, dir: 'LEFT' }],
      [{ id: 'char_a', golden: false, row: 9, col: 3, dir: 'SIDEWAYS' }, { id: 'char_b', golden: false, row: 9, col: 4, dir: 'LEFT' }],
      [{ id: '', golden: false, row: 9, col: 3, dir: 'UP' }, { id: 'char_b', golden: false, row: 9, col: 4, dir: 'LEFT' }],
    ];
    for (const cells of bad) {
      const m = fakeMatch({ seats: [{ bot: false, board: board(cells.map((c, i) => [`9,${3 + i}`, c.id || 'x', c.dir])) }] });
      // the recorder builds cells from a real board, so drive the corrupt path through a pre-staged record instead
      recordPrepLineups(m);
      flushMatchLineups(m);
      dropStagedLineups();
      appendFileSync(file, JSON.stringify({ t: 'lineup', at: 'now', modeId: 'coop', stageId: 'act1_m01', difficulty: 'HARD', round: 3, sig: 'x', cells }) + '\n');
    }
    reloadLibrary();
    const chosen = [{ uid: 'u1', id: 'char_a' }, { uid: 'u2', id: 'char_b' }];
    assert.deepEqual(humanPlans(fakeMatch(), chosen), [], 'corrupt lineups are skipped on load, not fatal');
    // and a well-formed one right next to them still loads
    appendFileSync(file, JSON.stringify({
      t: 'lineup', at: 'now', modeId: 'coop', stageId: 'act1_m01', difficulty: 'HARD', round: 3, sig: 'ok',
      cells: [{ id: 'char_a', golden: false, row: 9, col: 3, dir: 'UP' }, { id: 'char_b', golden: false, row: 9, col: 4, dir: 'LEFT' }],
    }) + '\n');
    reloadLibrary();
    assert.equal(humanPlans(fakeMatch(), chosen).length, 1, 'the valid lineup survived the corrupt neighbours');
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an externally synced library is picked up after reloadLibrary, without a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-lib-'));
  const file = join(dir, 'lib.jsonl');
  const old = process.env.SP_LINEUP_LIBRARY;
  process.env.SP_LINEUP_LIBRARY = file;
  const chosen = [{ uid: 'u1', id: 'char_a' }, { uid: 'u2', id: 'char_b' }];
  try {
    assert.deepEqual(humanPlans(fakeMatch(), chosen), [], 'nothing recorded yet');
    // a mirror pull / volume mount writes the file while this process is running
    appendFileSync(file, JSON.stringify({
      t: 'lineup', at: 'now', modeId: 'coop', stageId: 'act1_m01', difficulty: 'HARD', round: 3, sig: 'pulled',
      cells: [{ id: 'char_a', golden: false, row: 9, col: 3, dir: 'UP' }, { id: 'char_b', golden: false, row: 9, col: 4, dir: 'LEFT' }],
    }) + '\n');
    assert.deepEqual(humanPlans(fakeMatch(), chosen), [], 'the cache is per-process: still empty until reloaded');
    reloadLibrary();
    const plans = humanPlans(fakeMatch(), chosen);
    assert.equal(plans.length, 1, 'reloadLibrary re-reads the file');
    assert.equal(plans[0].get('u1'), '9,3');
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
    else delete process.env.SP_LINEUP_LIBRARY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with the feature off, staging and flushing stay no-ops (no file, no throw)', () => {
  const old = process.env.SP_LINEUP_LIBRARY;
  delete process.env.SP_LINEUP_LIBRARY;
  try {
    const m = fakeMatch({ seats: [{ bot: false, board: board([['9,3', 'char_a', 'UP'], ['9,4', 'char_b', 'LEFT']]) }] });
    recordPrepLineups(m);
    flushMatchLineups(m);
    dropStagedLineups();
    assert.equal(lineupFile(), null);
    assert.equal(lineupDir(), null);
    assert.deepEqual(humanPlans(m, [{ uid: 'u1', id: 'char_a' }]), []);
  } finally {
    if (old !== undefined) process.env.SP_LINEUP_LIBRARY = old;
  }
});
