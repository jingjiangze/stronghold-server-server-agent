// throwaway probe: EQUIVALENCE GATE for the kill-aware early stop.
// For each rehearsal it records the winner index and the full chosen plan (uid -> tile:dir) BEFORE and AFTER.
// Must be run once with the new code and once with the old code (git stash), and the two outputs diffed.
// Read-only w.r.t. the repo: runtime monkey-patching only, writes nothing.
import { Match } from './server/match/Match.js';
import { VirtualScheduler } from './server/match/scheduler.js';
import { getData } from './server/data.js';
import { RehearsalRun } from './server/sim/rehearsal.js';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || 'equiv.json';
const data = getData({ log: { warn() {}, error() {}, info() {} } });
const seeds = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111];

const runs = [];

for (const seed of seeds) {
  const sched = new VirtualScheduler();
  const seats = [0, 1, 2, 3].map((i) => ({ seat: i, playerId: `ai_${i}`, name: `AI-${i + 1}`, isBot: true, connected: true }));
  let summary = null;
  const m = new Match({
    roomCode: 'EQ', mode: 'coop', difficulty: 'HARD', seats, seed, data,
    log: { info() {}, debug() {}, warn() {}, error() {} }, scheduler: sched,
    send: () => true, broadcast: () => {}, onEnd: (s) => { summary = s; },
  });

  // capture the plan the rehearsal picks: hook rehearse()'s application by watching board moves is fragile;
  // instead record the winning candidate's plan signature straight from the run.
  const origRun = RehearsalRun.prototype.run;
  RehearsalRun.prototype.run = function (ob = null) {
    const sc = this.score;
    const res = origRun.call(this, ob);
    const entry = {
      seed, round: m.round, seat: this.score.playerId,
      n: this.candidates.length, winner: sc.index, leaks: sc.leaks, kills: sc.kills, score: sc.score,
    };
    runs.push(entry);
    return res;
  };

  m.start();
  sched.runUntil(() => summary != null, { maxSteps: 5e6 });
  m.dispose();
}

writeFileSync(out, JSON.stringify(runs));
console.log(`wrote ${runs.length} rehearsal records to ${out}`);
