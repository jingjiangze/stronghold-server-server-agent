// public/js/battle/rehearsalWorker.js — the host's side of a delegated bot layout rehearsal (DESIGN §14), a module
// Worker so whole simulated battles never touch the page's frame budget (the main thread keeps rendering the prep).
//
// battle/rehearsal.js (the page) sends the simulation data once and then one task per bot prep; this worker builds
// every candidate from its BattleSpec, runs them with the very comparison the server uses — server/sim/rehearsal.js
// (the same tick cap, early stop and score) — and answers the index of the winner. Nothing but that index leaves here;
// the layouts, the scoring and the placement stay on the server, so a rehearsal can never put a layout of its own on a
// board.
//
//   postMessage → { t: 'ready' }                                        once, when this script has been evaluated
//   onmessage ← { t: 'data', raw }                                      the page's /data/*.json (once, before any task)
//             ← { t: 'rehearsal', taskId, playerId, cap, specs }         one bot prep's candidates
//   postMessage → { t: 'done', taskId, choice } | { t: 'error', taskId, message }
//             ← { t: 'score', taskId, playerId, cap, specs }       布阵评分（客户端自学，不走服务端）
//   postMessage → { t: 'done', taskId, results }                 每条的 { index, built, leaks, kills, score }
//
// A candidate whose Battle cannot be built is skipped: the server's own rehearsal gets a finished stand-in for it and
// never scores it either (server/sim/rehearsal.js), so both sides compare the same candidates. A task that throws is
// answered as an error and the server runs the candidates itself. The page drops a task the server no longer waits for
// by terminating this worker (battle/rehearsal.js), so a stale simulation never holds it.

// The simulation modules are loaded the way the page loads them (`/sim/` is served from server/sim/, so it is no
// public/ path a static import could resolve — public/js/battle/runner.js imports them dynamically too).
const { createBattleFromSpec } = await import('/sim/spec.js');
const { DataSource, setSimData } = await import('/sim/simdata.js');
const { RehearsalRun } = await import('/sim/rehearsal.js');

/** The page's simulation data as a DataSource (null before the data frame arrives). */
let ds = null;

/**
 * Run one task and return the winning candidate index.
 * @param {{ taskId: string, playerId: string, cap: number, specs: object[] }} task
 */
function rehearse(task) {
  if (!ds) throw new Error('simulation data not loaded');
  // a candidate is built when the run reaches it (server/sim/rehearsal.js): a spec that does not build is skipped
  const run = new RehearsalRun(task.specs.map((spec) => () => createBattleFromSpec(spec, ds, { quiet: true, recordEvents: false })), task.playerId, task.cap);
  run.run();
  return run.score.index;
}

/**
 * Score every candidate and return the metrics (the page reports them; nothing is chosen here).
 * Runs each candidate through its own RehearsalRun, so a spec that cannot be built is reported as `built: false`
 * instead of silently skewing a batch — the same stand-in the server's rehearsal uses.
 * @param {{ taskId: string, playerId: string, cap: number, specs: object[] }} task
 */
function scoreCandidates(task) {
  if (!ds) throw new Error('simulation data not loaded');
  return task.specs.map((spec, index) => {
    try {
      const run = new RehearsalRun([() => createBattleFromSpec(spec, ds, { quiet: true, recordEvents: false })], task.playerId, task.cap);
      run.run();
      const s = run.score;
      return {
        index,
        built: true,
        leaks: Number.isFinite(s.leaks) ? s.leaks : null,
        kills: s.kills,
        score: Number.isFinite(s.score) ? s.score : null,
      };
    } catch (e) {
      return { index, built: false, error: String((e && e.message) || e) };
    }
  });
}

self.onmessage = (ev) => {
  const msg = ev && ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'data') {
    setSimData(msg.raw);
    ds = new DataSource(msg.raw, null);
    return;
  }
  if (msg.t !== 'rehearsal') return;
  try {
    if (msg.t === 'score') { self.postMessage({ t: 'done', taskId: msg.taskId, results: scoreCandidates(msg) }); return; }
    self.postMessage({ t: 'done', taskId: msg.taskId, choice: rehearse(msg) });
  } catch (e) {
    self.postMessage({ t: 'error', taskId: msg.taskId, message: String((e && e.message) || e) });
  }
};

// The page holds its first task until this arrives: a message posted to a module Worker before its graph is evaluated
// (the page's data frame would be) never reaches onmessage.
self.postMessage({ t: 'ready' });
