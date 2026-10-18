// throwaway probe: how much of a rehearsal's stepping is spent on candidates that are ALREADY
// provably unable to win? The existing early stop only looks at leaks, and only every 64 ticks.
// Read-only w.r.t. the repo: runtime monkey-patching only, writes nothing.
import { Match } from './server/match/Match.js';
import { VirtualScheduler } from './server/match/scheduler.js';
import { getData } from './server/data.js';
import { RehearsalRun } from './server/sim/rehearsal.js';

const cfg = { mode: 'coop', players: 4, difficulty: 'HARD' };
const seeds = [100, 101, 102, 103, 104, 105];
const data = getData({ log: { warn() {}, error() {}, info() {} } });

let scoreRef = null;

function runOne(seed) {
  const sched = new VirtualScheduler();
  const seats = [];
  for (let i = 0; i < cfg.players; i++) seats.push({ seat: i, playerId: `ai_${i}`, name: `AI-${i + 1}`, isBot: true, connected: true });
  let summary = null;
  const log = { info() {}, debug() {}, warn() {}, error() {} };
  const m = new Match({
    roomCode: 'PROBE', mode: cfg.mode, difficulty: cfg.difficulty, seats, seed, data,
    log, scheduler: sched, send: () => true, broadcast: () => {}, onEnd: (s) => { summary = s; },
  });

  // per-candidate tick accounting
  const st = { runs: 0, cands: 0, ticksAll: 0, ticksDoomed: 0, candsDoomed: 0, winsByIndex: {}, tickHist: [] };
  const origNewBattle = m.newBattle.bind(m);
  m.newBattle = (o) => {
    const b = origNewBattle(o);
    if (o && typeof o.fieldId === 'string' && o.fieldId.startsWith('r:') && typeof b.step === 'function') {
      const rec = { ticks: 0, doomed: false };
      st.cands++;
      const step = b.step.bind(b);
      b.step = () => {
        const t0 = performance.now();
        try { return step(); } finally {
          rec.ticks++;
          st.ticksAll++;
          if (rec.doomed) st.ticksDoomed++;
          // the run's own early-stop test, but evaluated every 8 ticks instead of every 64
          if (scoreRef && rec.ticks % 8 === 0 && scoreRef.leaks < Infinity) {
            const r = b.result();
            const pp = r && r.perPlayer && r.perPlayer[scoreRef.playerId];
            const leaks = pp ? (pp.leaked || []).filter((l) => l && l.counted !== false).length : 0;
            if (leaks > scoreRef.leaks) { rec.doomed = true; st.candsDoomed++; }
          }
        }
      };
      const origRes = b.result.bind(b);
      b.result = () => { const r = origRes(); if (b.finished) st.tickHist.push(rec.ticks); return r; };
    }
    return b;
  };

  const origRun = RehearsalRun.prototype.run;
  RehearsalRun.prototype.run = function (outOfBudget = null) {
    const sc = this.score;
    const prevScore = scoreRef;
    scoreRef = sc;
    const before = { all: st.ticksAll, doomed: st.ticksDoomed };
    const res = origRun.call(this, outOfBudget);
    st.runs++;
    st.winsByIndex[sc.index] = (st.winsByIndex[sc.index] || 0) + 1;
    st.ticksAllRun = (st.ticksAllRun || 0) + (st.ticksAll - before.all);
    st.ticksDoomedRun = (st.ticksDoomedRun || 0) + (st.ticksDoomed - before.doomed);
    scoreRef = prevScore;
    return res;
  };

  m.start();
  sched.runUntil(() => summary != null, { maxSteps: 5e6 });
  m.dispose();
  return { summary, st };
}

for (const s of seeds) {
  const { summary, st } = runOne(s);
  const doomedShare = st.ticksAll ? (100 * st.ticksDoomed / st.ticksAll) : 0;
  console.log(`seed ${s}: victory=${!!(summary && summary.victory)} runs=${st.runs} cands=${st.cands} `
    + `ticks=${st.ticksAll} ticksOnDoomed=${st.ticksDoomed} (${doomedShare.toFixed(1)}%) `
    + `candsDoomed=${st.candsDoomed} winsByIndex=${JSON.stringify(st.winsByIndex)}`);
}
