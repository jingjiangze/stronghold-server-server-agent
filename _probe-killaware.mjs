// throwaway probe: how much stepping would a KILL-AWARE provably-doomed criterion save?
// The score is -leaks*1000 + killed - index*0.01. A candidate is provably unable to win when its
// best achievable score can no longer exceed the incumbent's:
//   maxScore = -curLeaks*1000 + (curKills + remaining) - index*0.01   (leaks only rise, so curLeaks is a floor)
// This subsumes the existing "leaks > bestLeaks" stop.
// Read-only w.r.t. the repo: runtime monkey-patching only, writes nothing.
import { Match } from './server/match/Match.js';
import { VirtualScheduler } from './server/match/scheduler.js';
import { getData } from './server/data.js';
import { RehearsalRun } from './server/sim/rehearsal.js';

const data = getData({ log: { warn() {}, error() {}, info() {} } });
const seeds = [100, 101, 102, 103, 104, 105];

let scoreRef = null; // the RehearsalScore of the run currently stepping

function runOne(seed) {
  const sched = new VirtualScheduler();
  const seats = [0, 1, 2, 3].map((i) => ({ seat: i, playerId: `ai_${i}`, name: `AI-${i + 1}`, isBot: true, connected: true }));
  let summary = null;
  const m = new Match({
    roomCode: 'P', mode: 'coop', difficulty: 'HARD', seats, seed, data,
    log: { info() {}, debug() {}, warn() {}, error() {} }, scheduler: sched,
    send: () => true, broadcast: () => {}, onEnd: (s) => { summary = s; },
  });

  const st = {
    runs: 0, cands: 0, ticksAll: 0,
    ticksDoomedLeak: 0,      // what the CURRENT code stops (leaks > bestLeaks)
    ticksDoomedKill: 0,      // what a kill-aware criterion would stop (superset)
    candsDoomedLeak: 0, candsDoomedKill: 0,
    flips: 0,                // winners that would differ (must stay 0 for equivalence)
  };

  // this candidate's own index in the run's candidate list
  let myIndex = 0;
  const orig = m.newBattle.bind(m);
  m.newBattle = (o) => {
    const b = orig(o);
    if (o && typeof o.fieldId === 'string' && o.fieldId.startsWith('r:') && typeof b.step === 'function') {
      const rec = { ticks: 0, doomedLeak: false, doomedKill: false };
      rec.index = myIndex++;
      st.cands++;
      const step = b.step.bind(b);
      b.step = () => {
        try { return step(); } finally {
          rec.ticks++;
          st.ticksAll++;
          if (rec.doomedLeak) st.ticksDoomedLeak++;
          if (rec.doomedKill) st.ticksDoomedKill++;
          const sc = scoreRef;
          if (sc && sc.leaks < Infinity && rec.ticks % 16 === 0) {
            const r = b.result();
            const pp = r && r.perPlayer && r.perPlayer[sc.playerId];
            if (pp) {
              const curLeaks = (pp.leaked || []).filter((l) => l && l.counted !== false).length;
              const curKills = pp.killed || 0;
              const total = pp.total || 0;
              const remaining = Math.max(0, total - curKills - curLeaks);
              const idx = rec.index; // THIS candidate's own position in the candidate order
              const bestScore = sc.score;
              const maxScore = -curLeaks * 1000 + (curKills + remaining) - idx * 0.01;
              if (curLeaks > sc.leaks) { rec.doomedLeak = true; st.candsDoomedLeak++; }
              if (maxScore <= bestScore) { rec.doomedKill = true; st.candsDoomedKill++; }
            }
          }
        }
      };
    }
    return b;
  };

  const origRun = RehearsalRun.prototype.run;
  const origNote = RehearsalRun.prototype.constructor;
  RehearsalRun.prototype.run = function (ob = null) {
    const sc = this.score;
    const prev = scoreRef;
    scoreRef = sc;
    const before = { all: st.ticksAll, dl: st.ticksDoomedLeak, dk: st.ticksDoomedKill };
    const res = origRun.call(this, ob);
    st.runs++;
    scoreRef = prev;
    st.ticksAllRun = (st.ticksAllRun || 0) + (st.ticksAll - before.all);
    st.ticksDoomedLeakRun = (st.ticksDoomedLeakRun || 0) + (st.ticksDoomedLeak - before.dl);
    st.ticksDoomedKillRun = (st.ticksDoomedKillRun || 0) + (st.ticksDoomedKill - before.dk);
    return res;
  };

  m.start();
  sched.runUntil(() => summary != null, { maxSteps: 5e6 });
  m.dispose();
  return { summary, st };
}

let tot = { runs: 0, cands: 0, ticks: 0, leak: 0, kill: 0, candsKill: 0 };
for (const s of seeds) {
  const { st } = runOne(s);
  tot.runs += st.runs; tot.cands += st.cands; tot.ticks += st.ticksAll;
  tot.leak += st.ticksDoomedLeak; tot.kill += st.ticksDoomedKill; tot.candsKill += st.candsDoomedKill;
  console.log(`seed ${s}: runs=${st.runs} cands=${st.cands} ticks=${st.ticksAll} `
    + `curStop=${(100 * st.ticksDoomedLeak / st.ticksAll).toFixed(2)}% `
    + `killAware=${(100 * st.ticksDoomedKill / st.ticksAll).toFixed(2)}%`);
}
console.log('---');
console.log(`TOTAL ticks=${tot.ticks} (${(tot.ticks / 1e6).toFixed(2)}M)`);
console.log(`current early stop saves : ${(100 * tot.leak / tot.ticks).toFixed(2)}% of stepping`);
console.log(`kill-aware  would save   : ${(100 * tot.kill / tot.ticks).toFixed(2)}% of stepping`);
console.log(`extra saving             : ${(100 * (tot.kill - tot.leak) / tot.ticks).toFixed(2)}% of stepping`
  + `  (${(tot.kill - tot.leak).toLocaleString()} of ${tot.ticks.toLocaleString()} ticks)`);
console.log(`candidates the kill-aware rule flags: ${tot.candsKill} / ${tot.cands}`);
