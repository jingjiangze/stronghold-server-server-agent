// server/lineupLibrary.js — the human-lineup library the AI learns from, when one is configured.
//
// Opt-in via the environment: SP_LINEUP_LIBRARY = a JSONL file path OR a DIRECTORY. Without it nothing is recorded,
// nothing is read, and bot behavior is byte-identical to the default.
//
//   record — at every prep end (MatchPrep.endPrep) each HUMAN seat's final board is staged in memory (boardOrder +
//   pieceDir — the result summary's lineup omits dir), keyed by (modeId, stageId, difficulty, round). NOTHING is written
//   yet: the staged lineups are flushed only when the match really settles (MatchSettle.finish), and then only when the
//   settlement's reason is one the lineup can be judged on — victory or defeat, never error / abandoned / eliminated —
//   so a match that ended without a real result leaves no trace in the library. Each flush also drops anything that is
//   not a lineup: a board outside the field, an unknown facing, or a signature replayed far too often in one hour (a
//   farm, not a player). The rehearsal, not the record, judges quality: a recorded lineup is only one more candidate
//   the simulation may or may not pick.
//
//   learn — a bot arranging its layout asks the library for lineups of the SAME mode + stage + difficulty + round, maps
//   the recorded piece ids onto the pieces it actually drew this match (uids reset every match — Match.js uidSeq — so the
//   map is by piece id), and offers them as extra rehearsal candidates right after the default plan (they must survive
//   createRehearsalSteps' slice to botRehearsal; the default plan stays plans[0] — it is the layout applied while the
//   rehearsal still runs). Recorded pieces the bot has no copy of are dropped; the caller's fallback fills whatever is
//   left off the board (applyPlanSteps' second pass). Board coordinates are the player's own everywhere (the boss
//   halves mirror the stage, not the board), so cells replay as recorded.
//
// The load is synchronous and once per process (a library file is at most a few MiB — see the caps below); the append
// is fire-and-forget. reloadLibrary() drops the cache so an externally synced library (a mirror pull, a volume mount
// appearing late) is re-read without a restart.
//
// The file is a rolling window, not an archive: it is capped at MAX_LINES lines / MAX_BYTES of the NEWEST lineups
// (appendLine). At ~0.7 KiB per lineup that is a few MiB no matter how long the server runs, so the library cannot
// fill a disk; what it can do is forget old lineups, which is the intended trade.
//
// Where it lives: one JSONL file per mode under one directory. A directory path (SP_LINEUP_LIBRARY) holds
// <LIBRARY_PREFIX><modeId>.jsonl, so every mode learns in isolation — the modes share neither the stage pool
// (modes[*].stages in data/config.json) nor the difficulty class, and a lineup that fits one does not have to fit
// another. A file path is still accepted (the single-mode, pre-split layout); its lineups key without a mode, so a
// deployment that upgrades keeps reading what it wrote. Missing parent directories are created, so a fresh volume
// mount or a not-yet-created library directory just works.

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { appendFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { boardOrder, tileKey, pieceDir, inField } from './match/board.js';
import { isDir as isDirName } from './sim/dir.js';
import { parseRemoteSpec, remoteCacheFile } from './lineupSync.js';
import { enqueueOutbox, outboxEnabled } from './lineupOutbox.js';

/** Recorded lineups offered per bot per prep (on top of the default plan and the parametric variants). */
const PLANS_PER_PREP = 2;
/** Distinct lineups kept per (stageId, difficulty, round) key when loading. */
const PER_KEY_KEEP = 6;
/** Whole-file caps. A library past either one drops its oldest decile and rewrites the window in place. */
const MAX_LINES = 4000;
const MAX_BYTES = 3 * 1024 * 1024;
/** How much of the file is read at startup: enough to fill the window even from an over-cap file. */
const READ_LIMIT = MAX_BYTES * 2;
/** Per-mode file prefix inside a library directory: <dir>/<LIBRARY_PREFIX><modeId>.jsonl. */
const LIBRARY_PREFIX = 'lineups_';
/** The single-file layout's key part for modeId (it predates the split and carries no mode). */
const NO_MODE = '';
/** Settlement reasons whose lineups are worth learning from. `error` / `abandoned` / `eliminated` are not: a match
 *  that broke, emptied out or died half-way never showed a lineup that actually held. `defeat` IS included — a team
 *  that reached the boss and lost still played real, complete rounds. */
const USABLE_REASONS = new Set(['victory', 'defeat']);
/** A lineup signature seen more than this many times inside one hour is a farm, not a player: dropped. */
const FARM_WINDOW_MS = 60 * 60 * 1000;
const FARM_MAX_PER_WINDOW = 40;
/** Recent accepted signatures, for the farm check: sig → timestamps ([] cleared once all fall out of the window). */
const recent = new Map();

/**
 * Is this a farm rather than a player? A signature replayed more than FARM_MAX_PER_WINDOW times inside an hour is one
 * seat grinding the same board to feed the library, not a human trying a lineup once. The check is on the signature
 * only, so a legitimately popular lineup seen by many different players still counts each replay — the point is the
 * rate, not the popularity. The window is trimmed lazily; memory is bounded by the number of distinct signatures.
 */
function isFarm(rec) {
  const now = Date.now();
  let times = recent.get(rec.sig);
  if (!times) recent.set(rec.sig, (times = []));
  times.push(now);
  while (times.length && now - times[0] > FARM_WINDOW_MS) times.shift();
  if (times.length > FARM_MAX_PER_WINDOW) {
    times.pop(); // do not let one farm's own count keep growing the window
    return true;
  }
  if (recent.size > 10000) for (const [sig, ts] of recent) if (!ts.length) recent.delete(sig);
  return false;
}

/** Every cell inside the field with a real facing: anything else is corruption, not a lineup. */
function validCells(cells) {
  for (const c of cells) {
    if (!c || typeof c.id !== 'string' || !c.id) return false;
    if (!inField(c.row, c.col)) return false;
    if (!isDirName(c.dir)) return false;
  }
  return true;
}

let cache = null; // { file, byKey: Map<string, cells[]>, seen: Set<string>, order: string[], lines: int, bytes: int }

/** Is this an existing directory (the env var may name one)? */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The library key (file stem) for a mode + difficulty: `<modeId>__<DIFFICULTY>`.
 *
 * 玩法与难度各成一套库：`mode_single_hard__HARD.jsonl` 与 `mode_multi_hard__HARD.jsonl` 互不影响，
 * 同一玩法下 `mode_single_hard__HARD` 与 `mode_single_normal__NORMAL` 也互不影响。分隔符是**双下划线**：
 * modeId 自己含单下划线（`mode_single_hard`），单下划线会分不开模式与难度；双下划线在两侧字符集
 * （`[A-Za-z0-9_]`）里不会自然出现，解析唯一。难度缺省（老的单文件布局）时退化为 modeId 本身。
 * @param {string} [modeId] @param {string} [difficulty]
 */
export function libraryKey(modeId, difficulty) {
  const mode = modeId || NO_MODE;
  const diff = String(difficulty || '').trim().toUpperCase();
  return diff ? `${mode}__${diff}` : mode;
}

/** Split a library key back into { modeId, difficulty } (difficulty null for the legacy per-mode shape). */
export function splitLibraryKey(key) {
  const m = /^([A-Za-z0-9_]+?)__([A-Z][A-Z0-9_]*)$/.exec(String(key || ''));
  return m ? { modeId: m[1], difficulty: m[2] } : { modeId: String(key || ''), difficulty: null };
}

/**
 * The library file for `modeId` + `difficulty`, or null (feature off). SP_LINEUP_LIBRARY names either:
 *   remote:<urls>|<cacheDir> → <cacheDir>/lineups_<key>.jsonl — a read-only remote synced here by
 *                               server/lineupSync.js before the load (below); the path this returns is LOCAL,
 *                               so the synchronous read path never learns the difference;
 *   a directory  → <dir>/lineups_<key>.jsonl (created if missing) — the split layout, one file per mode+difficulty;
 *   a file       → that file, whatever the mode — the single-file layout (mode/difficulty are then not part of the key).
 * A path that does not exist and has no extension is treated as a directory. Parent directories are created, so a
 * fresh volume mount or a not-yet-created library directory just works.
 * @param {string} [modeId] @param {string} [difficulty]
 */
export function lineupFile(modeId, difficulty) {
  const raw = process.env.SP_LINEUP_LIBRARY;
  if (!raw || !raw.trim()) return null;
  const p = raw.trim();
  const key = libraryKey(modeId, difficulty);
  // A remote spec short-circuits first: isDir/existsSync/extname below would treat a URI as a path and mkdirSync
  // would create a junk directory named after it. The cache dir is local, so only it is created here.
  const remote = remoteSpecOf(p);
  const file = remote ? remoteCacheFile(remote.cacheDir, key)
    : isDir(p) ? join(p, `${LIBRARY_PREFIX}${key}.jsonl`)
      : !existsSync(p) && !extname(p) ? join(p, `${LIBRARY_PREFIX}${key}.jsonl`)
        : p;
  try {
    const dir = dirname(resolve(file));
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('[lineupLibrary] cannot create the library directory:', e && e.message);
    return null; // telemetry off rather than throwing into a match
  }
  return file;
}

/** The parsed remote spec of an env value, or null (a plain local path). */
function remoteSpecOf(raw) {
  try {
    return parseRemoteSpec(raw);
  } catch {
    return null; // a malformed spec degrades to "feature off", never to a crash in a match
  }
}

/** The library directory: where a deployment mounts / backs up / publishes. Null when the feature is off. */
export function lineupDir() {
  const probe = lineupFile(NO_MODE, null);
  if (!probe) return null;
  try {
    return dirname(resolve(probe));
  } catch {
    return null;
  }
}

/** True when the configured path is the split layout (a directory of per-mode files) — remote included. */
export function lineupIsSplit() {
  const raw = process.env.SP_LINEUP_LIBRARY;
  if (!raw || !raw.trim()) return false;
  const p = raw.trim();
  if (remoteSpecOf(p)) return true; // a remote library is per-mode by construction
  return isDir(p) || (!existsSync(p) && !extname(p));
}

/** The parsed remote library spec, or null — what server/index.js needs to start server/lineupSync.js. */
export function lineupRemoteSpec() {
  const raw = process.env.SP_LINEUP_LIBRARY;
  if (!raw || !raw.trim()) return null;
  return remoteSpecOf(raw.trim());
}

/** The library keys (`<modeId>__<DIFFICULTY>` stems) that already have a file — what the publisher walks. */
export function lineupModes() {
  const dir = lineupDir();
  if (!dir) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const m = new RegExp(`^${LIBRARY_PREFIX}(.+)\\.jsonl$`).exec(n);
    if (m) out.push(m[1]);
  }
  return out.sort();
}

function keyOf(modeId, stageId, difficulty, round) {
  return `${modeId || NO_MODE}|${stageId || ''}|${difficulty || ''}|${round}`;
}

/** Canonical signature of a lineup: which piece stands where, facing which way. */
function sigOf(cells) {
  return cells
    .map((c) => `${c.id}:${c.golden ? 1 : 0}:${c.row}:${c.col}:${c.dir}`)
    .sort()
    .join('|');
}

/** The newest `limit` bytes of a file; null when it cannot be read (a missing file is an empty library). */
function readTail(file, limit) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buf = Buffer.allocUnsafe(size - start);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, start + at);
      if (n <= 0) break;
      at += n;
    }
    return buf.toString('utf8', 0, at);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Load the JSONL file once per process; corrupt lines are skipped, not fatal; a missing file is an empty library.
 * A file past the caps is read from its tail, so only the window that would survive the next roll is used.
 */
function load(file) {
  const byKey = new Map();
  const seen = new Set();
  const order = [];
  const text = readTail(file, READ_LIMIT);
  if (text === null) return { byKey, seen, order, lines: 0, bytes: 0 };
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      continue;
    }
    if (!rec || rec.t !== 'lineup' || !Array.isArray(rec.cells) || !rec.cells.length) continue;
    if (!validCells(rec.cells)) continue; // a corrupt line is skipped, not fatal
    const sig = sigOf(rec.cells);
    if (seen.has(sig)) continue;
    seen.add(sig);
    index({ byKey }, rec);
    order.push(s);
  }
  const bytes = order.reduce((n, s) => n + Buffer.byteLength(s) + 1, 0);
  return { byKey, seen, order, lines: order.length, bytes };
}

/** A key's cell list (grown on demand — callers never see the gap). */
function bucket(lib, key) {
  let list = lib.byKey.get(key);
  if (!list) lib.byKey.set(key, (list = []));
  return list;
}

/** Remember a cells array in the index (no file write). */
function index(lib, rec) {
  const key = keyOf(rec.modeId, rec.stageId, rec.difficulty, rec.round);
  const list = bucket(lib, key);
  if (list.length < PER_KEY_KEEP) list.push(rec.cells);
}

/** The library for `modeId` — one file per mode under a directory, one file for everything in the single-file layout. */
function library(modeId, difficulty) {
  const file = lineupFile(modeId, difficulty);
  if (!file) return null;
  if (!cache || cache.file !== file) cache = { file, modeId: modeId || NO_MODE, ...load(file) };
  return cache;
}

/** Re-read the library files from disk (an externally synced library must be picked up without a restart). */
export function reloadLibrary() {
  cache = null;
}

/**
 * Stage the HUMAN seats' final boards at the end of a prep (called from MatchPrep.endPrep, after PlayerState.endPrep
 * ran — this is the layout that enters the fight). Staging is in-memory only: nothing reaches the file until
 * flushMatchLineups runs (MatchSettle.finish), so a match that never settles leaves nothing behind. A prep that runs
 * with the feature off stages nothing at all.
 * Fire-and-forget: a telemetry failure must never fail a prep, nor land in the match's error count (that is the
 * result screen's `errors`).
 * @param {import('./match/Match.js').Match} m
 */
export function recordPrepLineups(m) {
  if (!lineupFile(m.modeId, m.difficulty)) return;
  try {
    for (const ps of m.alivePlayers()) {
      if (ps.botControlled) continue;
      const cells = [];
      for (const { r, c, piece } of boardOrder(ps.board)) {
        if (piece.kind !== 'chess') continue;
        cells.push({ id: piece.id, golden: m.gd.isGolden(piece.id), row: r, col: c, dir: pieceDir(piece) });
      }
      if (cells.length < 2) continue; // a nearly-empty board teaches nothing
      staged.push({
        t: 'lineup',
        at: new Date().toISOString(),
        modeId: m.modeId,
        stageId: m.stageId || null,
        difficulty: m.difficulty || null,
        round: m.round,
        sig: sigOf(cells),
        cells,
      });
    }
  } catch (e) {
    console.error('[lineupLibrary] record failed:', e && e.message);
  }
}

/** Lineups staged by recordPrepLineups but not yet written (one match's preps, dropped if it never settles). */
const staged = [];

/** Discard the staged lineups (a match that will never settle — MatchPlatform.dispose). */
export function dropStagedLineups() {
  staged.length = 0;
}

/**
 * Write the staged lineups. Called exactly where a match settles (MatchSettle.finish), i.e. only for matches that
 * really produced a result; the stage is cleared either way, so an abandoned match's boards are never published.
 * `outcome` is the settlement's reason record ({ victory, reason }): `error` / `abandoned` / `eliminated` never wrote a
 * lineup that actually held, so only `victory` and `defeat` are learned from. A caller that passes no outcome (a test,
 * or a settle path with no reason yet) publishes whatever it staged, as before.
 * @param {import('./match/Match.js').Match} m
 * @param {{victory?: boolean, reason?: string}} [outcome]
 */
/** 结算后通知上层的「立即补传」（由 index.js 接到 outbox.requestFlush；未接入时为空）。 */
let flushHook = null;

/** @param {(() => void) | null} fn */
export function setLineupFlushHook(fn) { flushHook = typeof fn === 'function' ? fn : null; }

export function flushMatchLineups(m, outcome) {
  const usable = !outcome || USABLE_REASONS.has(outcome.reason);
  const batch = usable ? staged.splice(0, staged.length) : [];
  if (!usable) staged.length = 0; // a match that broke or died half-way teaches nothing
  const queued = [];
  for (const rec of batch) {
    if (isFarm(rec)) continue; // a farm is not a player
    if (!validCells(rec.cells)) continue; // out-of-field or bad facing: corrupt, not a lineup
    void appendLine(rec.modeId, rec.difficulty, rec);
    queued.push(rec);
  }
  // The outbox mirror (方案 a，与 lineup-github-r2 会话的专用数据通道同一口径): the same gated batch
  // rides to the center through the publish channel when the outbox is on. Fire-and-forget inside; a dead
  // network only means the queue grows until the next successful flush. A remote-spec server is a reader by
  // construction (same posture as the publish block in index.js): no queue.
  if (queued.length && outboxEnabled() && !lineupRemoteSpec()) {
    const dir = lineupDir();
    if (dir) void enqueueOutbox(dir, queued, { mid: m?.battlePrefix ?? null, outcome: outcome && { victory: !!outcome.victory, reason: outcome.reason } });
    // 结算即触发补传（不再等 15 分钟的定时器）：合并窗口由 outbox 自己控制，失败只影响本轮。
    try { flushHook?.(); } catch { /* a broken hook must never fail a settle */ }
  }
  void m; // the match is the caller's anchor; the records carry their own stageId/difficulty/round
}

async function appendLine(modeId, difficulty, rec) {
  const lib = library(modeId, difficulty);
  if (!lib) return;
  if (lib.seen.has(rec.sig)) return; // no duplicate lines for a lineup we already know
  lib.seen.add(rec.sig);
  index(lib, rec);
  const line = JSON.stringify(rec) + '\n';
  const file = lib.file;
  try {
    await appendFile(file, line, 'utf8');
  } catch (e) {
    lib.seen.delete(rec.sig); // the write failed: allow a later attempt
    console.error('[lineupLibrary] append failed:', e && e.message);
    return;
  }
  // rolling window: past either cap, rewrite the newest 90% of the lines in place. Only this process's own appends
  // cross a cap, so the rewrite is a superset of what the read-side cap keeps — nothing the AI can use is lost.
  lib.bytes += Buffer.byteLength(line);
  lib.order.push(line.slice(0, -1)); // the roll rewrites the file from these lines
  if (++lib.lines <= MAX_LINES && lib.bytes <= MAX_BYTES) return;
  await roll(file, lib);
}

/** Drop the oldest decile of the library file and reset the window's counters. */
async function roll(file, lib) {
  let keepFrom = Math.floor(lib.lines * 0.1); // the oldest decile goes
  const bytesFrom = (from) => lib.order.slice(from).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  // a library of unusually fat lineups can cross the byte cap with few lines: keep dropping the oldest until it fits
  while (keepFrom < lib.lines - 1 && bytesFrom(keepFrom) > MAX_BYTES) keepFrom++;
  const kept = lib.order.slice(keepFrom);
  const body = kept.map((l) => l + '\n').join('');
  // Write the window to a temp file and rename it into place: an in-place writeFile leaves the file
  // PARTIAL while it runs, and a concurrent reader (another process's publisher/syncer, a test) sees a
  // truncated library. rename() is atomic: a reader sees either the old window or the new one.
  const tmp = `${file}.${process.pid}.partial`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, file);
  } catch (e) {
    console.error('[lineupLibrary] roll failed:', e && e.message);
    try { await rm(tmp, { force: true }); } catch { /* best effort */ }
    return; // counters stay high so the next append retries the roll; the file is at most one decile over
  }
  lib.lines = kept.length;
  lib.bytes = Buffer.byteLength(body);
  lib.order = kept;
}

/** A LayoutPlan stand-in: Map<uid, tileKey> with .dirs (bot.js LayoutPlan without the import cycle). */
class Plan extends Map {
  constructor(entries) {
    super(entries);
    this.dirs = new Map();
  }
}

/**
 * The recorded human lineups for THIS stage / difficulty / round, mapped onto the pieces `chosen` actually holds.
 * Synchronous: called from bot.js arrangeSteps, a step generator.
 * @returns {Array<Plan>} empty when the feature is off or nothing was recorded for this context
 */
export function humanPlans(m, chosen) {
  const lib = library(m.modeId, m.difficulty);
  if (!lib) return [];
  const cellsList = lib.byKey.get(keyOf(m.modeId, m.stageId, m.difficulty, m.round));
  if (!cellsList || !cellsList.length) return [];
  const out = [];
  for (const cells of cellsList) {
    const plan = new Plan();
    const free = new Set(chosen);
    for (const c of cells) {
      // one recorded piece maps to one unused chosen piece of the same id; facing replays as recorded
      const p = [...free].find((q) => q.id === c.id);
      if (!p) continue;
      free.delete(p);
      plan.set(p.uid, tileKey(c.row, c.col));
      plan.dirs.set(p.uid, c.dir);
    }
    if (plan.size >= 2) out.push(plan);
    if (out.length >= PLANS_PER_PREP) break;
  }
  return out;
}
