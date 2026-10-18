// throwaway smoke probe: the lineup library wired into a REAL match.
//   match A: records seat 0's final prep board each round (flipped to "human" for the recorder only)
//   match B: same seed, library on  — the AI must get the recorded lineup offered as an extra rehearsal candidate
//   match C: same seed, library off — baseline
// Injection is proven when B's rehearsal-candidate boards differ from C's (same seed ⇒ everything else identical).
// Read-only w.r.t. the repo; the library file lives in a temp dir.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Match } from './server/match/Match.js';
import { PlayerState } from './server/match/PlayerState.js';
import { VirtualScheduler } from './server/match/scheduler.js';
import { getData } from './server/data.js';
import { recordPrepLineups } from './server/lineupLibrary.js';
import { PHASE } from './shared/constants.js';

const SEED = 20261015;
const log = { info() {}, debug() {}, warn(...a) { console.log('[warn]', ...a); }, error(...a) { console.log('[error]', ...a); } };
const data = getData({ log });

const libDir = mkdtempSync(join(tmpdir(), 'sp-learn-'));
const libFile = join(libDir, 'lib.jsonl');

// every prep end (all matches): record every seat's board as if humans played it (botControlled is a computed
// getter `isBot || left || autoplay` — swapped only for the duration of the recorder call)
const botCtrlDesc = Object.getOwnPropertyDescriptor(PlayerState.prototype, 'botControlled');
const origEndPrep = Match.prototype.endPrep;
Match.prototype.endPrep = function () {
  if (this.phase === PHASE.PREP) {
    Object.defineProperty(PlayerState.prototype, 'botControlled', { ...botCtrlDesc, get() { return false; } });
    try {
      recordPrepLineups(this);
    } finally {
      Object.defineProperty(PlayerState.prototype, 'botControlled', botCtrlDesc);
    }
  }
  return origEndPrep.call(this);
};

function runMatch(tag, buckets) {
  const sched = new VirtualScheduler();
  const seats = [];
  for (let i = 0; i < 4; i++) seats.push({ seat: i, playerId: `ai_${i}`, name: `AI-${i + 1}`, isBot: true, connected: true });
  let summary = null;
  const m = new Match({
    roomCode: tag, mode: 'coop', difficulty: 'HARD', seats, seed: SEED, data,
    log, scheduler: sched, send: () => true, broadcast: () => {}, onEnd: (s) => { summary = s; },
  });
  const orig = m.newBattle.bind(m);
  m.newBattle = (o) => {
    if (o && typeof o.fieldId === 'string' && o.fieldId.startsWith('r:')) {
      const key = `${m.round}:${o.fieldId.slice(2)}`;
      (buckets[key] ||= new Set()).add(JSON.stringify(o.players[0]));
    }
    return orig(o);
  };
  m.start();
  sched.runUntil(() => summary != null, { maxSteps: 5e6 });
  m.dispose();
  return summary;
}

// --- match A: record --------------------------------------------------------
process.env.SP_LINEUP_LIBRARY = libFile;
const a = runMatch('LEARNA', {});
await new Promise((r) => setTimeout(r, 200)); // the append is fire-and-forget: let the I/O flush before reading
let recs = [];
try {
  recs = readFileSync(libFile, 'utf8').trim().split('\n').filter(Boolean);
} catch {
  recs = ['(no file)'];
}

// --- match B: learn ---------------------------------------------------------
const bBuckets = {};
const b = runMatch('LEARNB', bBuckets);

// --- match C: baseline (feature off) ----------------------------------------
delete process.env.SP_LINEUP_LIBRARY;
const cBuckets = {};
const c = runMatch('LEARNC', cBuckets);

// --- compare -----------------------------------------------------------------
let diffKeys = 0;
let diffCands = 0;
for (const key of new Set([...Object.keys(bBuckets), ...Object.keys(cBuckets)])) {
  const B = bBuckets[key] || new Set();
  const C = cBuckets[key] || new Set();
  const onlyB = [...B].filter((x) => !C.has(x));
  const onlyC = [...C].filter((x) => !B.has(x));
  if (onlyB.length || onlyC.length) {
    diffKeys++;
    diffCands += onlyB.length + onlyC.length;
    console.log(`DIFF ${key}: +${onlyB.length} / -${onlyC.length} candidates`);
  }
}
console.log('');
console.log(`A summary: ${a ? `victory=${a.victory} rounds=${a.roundsPassed}` : 'NULL (match never ended)'}`);
console.log(`A recorded ${recs.length} lineups ${recs[0] && recs[0].startsWith('{') ? `(json lines; first: ${recs[0].slice(0, 160)})` : recs[0]}`);
console.log(`B summary: ${b ? `victory=${b.victory} rounds=${b.roundsPassed}` : 'NULL (match never ended)'}`);
console.log(`C summary: ${c ? `victory=${c.victory} rounds=${c.roundsPassed}` : 'NULL (match never ended)'}`);
console.log(`B vs C: ${diffKeys} (round,seat) keys with a different candidate pool, ${diffCands} candidate boards differ`);
if (b && c) {
  let sameSeats = 0;
  for (let i = 0; i < 4; i++) {
    const seat = (s) => s.players.find((p) => p.seat === i);
    const lb = JSON.stringify(seat(b).lineup.map((e) => [e.id, e.row, e.col]));
    const lc = JSON.stringify(seat(c).lineup.map((e) => [e.id, e.row, e.col]));
    if (lb === lc) sameSeats++;
    else console.log(`seat ${i} final layout CHANGED by learning: B=${lb} C=${lc}`);
  }
  console.log(`final layouts identical for ${sameSeats}/4 seats (learned candidates won ${4 - sameSeats} seats' decisions at some round)`);
}

rmSync(libDir, { recursive: true, force: true });
