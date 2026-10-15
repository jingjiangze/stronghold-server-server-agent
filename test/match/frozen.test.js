// test/match/frozen.test.js — the volunteer-freeze: every connected human of a co-op match is gone ⇒ the battle holds
// (server/match/match/frozen.js, DESIGN §14). The server never runs a match on the players' behalf, so instead of
// playing on alone the match freezes: fields stop, clocks stop with them, the room is held (server/lobby.js
// disposeOrHoldRoom / holdForReconnect) and the first volunteer back thaws it. Nobody back in FROZEN_MS ⇒ abandoned,
// like a solo run nobody resumes.
//
// The freeze reuses the solo pause's machinery (this.paused / _pausedAt / _resume's shifted clocks), so these tests
// check the freeze's own three states (hold / thaw / give up) and that the pause gate stays exact for g.pause.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeMatch } from './harness.js';
import { FROZEN_MS } from '../../server/match/match/frozen.js';
import { HeadlessJob, runHeadless } from '../../server/match/fields.js';
import { compactResult, createBattleFromSpec } from '../../server/sim/spec.js';
import { ERR, PHASE } from '../../shared/constants.js';

/** Drive a co-op match into the first battle round with every human on autoplay (server-run fields, no client-combat).
 *
 * `instant: false` is the tested pacing of a *running* battle (the solo pause's suites use it too, leftovers.test.js):
 * the FieldRunner paces through `_pump`, which reads `m.paused`. The harness default `instant` runs the whole battle to
 * completion inside one synchronous callback (`_runInstant`, fields.js:163) that never re-checks `paused`, so a battle
 * that must still be alive while the clocks are moved by hand has to be paced instead. */
function coopInCombat({ humans = 2, bots = 1, fake = true, script = null, instant = false } = {}) {
  const h = makeMatch({
    mode: 'coop', difficulty: 'FUNNY', humans, bots, seed: 7, fake, script: script || undefined, instant,
  }).start();
  // the humans must answer INFO_CHECK (infoReady) before autoplay can carry them: h.drive does that, h.run alone does not
  h.autoHumans();
  h.drive(() => h.m.phase === PHASE.COMBAT && h.m.round === 1, { maxSteps: 3e6 });
  assert.equal(h.m.phase, PHASE.COMBAT, `expected COMBAT R1, got ${h.m.phase} R${h.m.round}`);
  return h;
}

test('gate: g.pause still refuses a co-op battle and the hold is the match\'s own call', () => {
  const h = coopInCombat();
  // a human may still not pause a co-op battle, frozen or not (the WRONG_PHASE gate of pause.js is unchanged)
  assert.equal(h.m.handle('p_0', { t: 'g.pause', on: true }).error, ERR.WRONG_PHASE, 'co-op battles never pause');
  assert.equal(h.m.publicView().frozen, false);
  assert.equal(h.m.publicView().paused, false);
  // { on: false } is always accepted, frozen or not (the room's thaw is unconditional)
  assert.deepEqual(h.m.setFrozen(false), { ok: true });
  h.m.dispose();
});

test('a held PREP does not advance: the phase countdown is held and re-armed with the time it had left', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 2, bots: 1, seed: 7, fake: true }).start();
  h.runToPhase(PHASE.PREP, 1);
  const m = h.m;
  const deadline = m.deadline;
  assert.ok(m._phaseTimer, 'the prep countdown is armed');
  assert.ok(deadline > m.sched.now(), 'and published as m.public.deadline');

  assert.deepEqual(m.setFrozen(true), { ok: true });
  assert.equal(m.frozen, true, 'a non-battle phase is holdable now (the AI seats would otherwise finish it alone)');
  assert.equal(m.paused, true);
  assert.equal(m.publicView().frozen, true);
  assert.equal(m._phaseTimer, null, 'the prep countdown is cancelled by the hold');
  assert.equal(typeof m._phaseFn, 'function', 'and keeps its callback for the thaw');

  // two virtual minutes of hold: the deadline would have run out long ago, and nothing may move
  m.sched.advance(120_000);
  assert.equal(m.phase, PHASE.PREP, 'a held PREP does not advance');
  assert.equal(m._clockNow(), m.frozenAt, 'the clock reads the hold instant');
  assert.equal(m.deadline, deadline, 'and the published deadline is shifted, never run out');

  assert.deepEqual(m.setFrozen(false), { ok: true });
  assert.ok(m._phaseTimer, 'the countdown is re-armed');
  assert.ok(m.deadline > m.sched.now(), 'with the time it had left (not the whole interval)');
  assert.deepEqual(m.setFrozen(false), { ok: true }, 'the thaw is idempotent');
  m.dispose();
});

test('every volunteer gone during PREP: the match holds instead of preparing for nobody', () => {
  // The reported hole (2026-10-15): `setFrozen` used to refuse outside a battle, so the match advanced through PREP
  // into COMBAT and played a whole battle with zero connected volunteers (settled `reason: 'defeat'`). A held PREP
  // must neither run out nor end because the AI seats finished their own prep.
  const h = makeMatch({
    mode: 'coop', difficulty: 'FUNNY', humans: 2, bots: 1, seed: 7, fake: true, instant: false,
  }).start();
  h.autoHumans();
  h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 1, { maxSteps: 3e6 });
  const m = h.m;
  assert.deepEqual(m.setFrozen(true), { ok: true });

  // the AI seats keep preparing under the hold (their work is bounded and theirs), and once they are ready
  // `maybeEndPrep` comes due — the step must be queued, not run
  m.sched.advance(60_000);
  assert.equal(m.phase, PHASE.PREP, 'PREP did not end under the hold');
  assert.ok(m._frozenQueue.length > 0, 'the end-prep step the hold caught is queued for the thaw');
  assert.equal(m._clockNow(), m.frozenAt);

  // the thaw runs it: PREP ends, and the battle starts with a volunteer back
  assert.deepEqual(m.setFrozen(false), { ok: true });
  assert.equal(m._frozenQueue.length, 0, 'the queue was drained');
  h.drive(() => m.phase === PHASE.COMBAT, { maxSteps: 3e6 });
  assert.equal(m.phase, PHASE.COMBAT, 'the match resumes into the battle it was holding');
  h.runToEnd();
  assert.deepEqual(h.logs.error, [], 'no error logged');
  m.dispose();
});

test('a lobby / result phase has nothing to hold; a solo match keeps its own pause', () => {
  const h = coopInCombat();
  const m = h.m;
  // RESULT is the only other non-running phase (LOBBY has no match yet, so the room never asks for a hold)
  const phase = m.phase;
  m.phase = PHASE.RESULT;
  const r = m.setFrozen(true);
  assert.equal(r.ok, undefined, 'a refusal is common.js fail()\'s { error, detail } shape');
  assert.equal(r.error, ERR.WRONG_PHASE);
  assert.equal(m.frozen, false, 'nothing was frozen');
  assert.equal(m.publicView().paused, false);
  m.phase = phase;
  assert.deepEqual(m.setFrozen(false), { ok: true });
  m.dispose();
});

test('a solo match is left to its own pause: setFrozen refuses it', () => {
  // a solo match is refused before any phase matters (the room never asks one to freeze): the phase check is moot,
  // and its own pause path is verified by test/\docs-consistency.test.js
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 7, fake: true }).start();
  const r = h.m.setFrozen(true);
  assert.equal(r.ok, undefined);
  assert.equal(r.error, ERR.WRONG_PHASE);
  assert.equal(r.detail, 'solo matches use the pause');
  assert.equal(h.m.frozen, false);
  h.m.dispose();
});

test('every volunteer gone ⇒ the battle holds: paused + frozen, the field clock stops, the room may be held', () => {
  const h = coopInCombat();
  const m = h.m;
  // `f.cc` marks a client-combat field; the harness runs server-side fields by default, so the live-field
  // predicate is `f.live && !f.done` (exactly what setFrozen checks)
  const f0 = m.fields.find((f) => f.live && !f.done);
  assert.ok(f0, 'a live field');
  const before = m._clockNow();

  assert.deepEqual(m.setFrozen(true), { ok: true });
  assert.equal(m.frozen, true);
  assert.equal(m.frozenAt, before, 'frozenAt is the scheduler instant of the hold');
  assert.equal(m.paused, true, 'the freeze reuses the pause (m.public.paused drives the browsers)');
  assert.equal(m._pausedAt, before);
  assert.equal(m.publicView().frozen, true);
  assert.equal(m.publicView().paused, true);
  // the field's result timers are cancelled and re-armed on the thaw, not left running (server fields use
  // doneTimer/rearmRelease; client-combat fields deadlineTimer/rearmDeadline — both are covered by pause.js)
  assert.equal(f0.deadlineTimer ?? null, null);
  assert.equal(f0.doneTimer ?? null, null);

  // the field clock is frozen at the hold instant while the freeze holds (a virtual battle that ends under the
  // freeze drops it instead — that is _clearFrozen, covered further down)
  assert.equal(m._clockNow(), before, 'the field clock reads the hold instant');
  assert.equal(m._pausedAt, before);
  assert.equal(m.pausedMs, 0, 'nothing counted yet');
  assert.equal(m.phase, PHASE.COMBAT);
  assert.equal(h.ended, null, 'a frozen match does not end');

  // a second hold is a no-op (idempotent)
  assert.deepEqual(m.setFrozen(true), { ok: true });
  assert.equal(m.frozenAt, before, 'frozenAt did not move');

  // the thaw: a volunteer is back, the clocks move on by the frozen time. A virtual battle would end the moment
  // time advances (that is _clearFrozen), so the frozen span is taken on the clock itself.
  m._pausedAt -= 60_000;
  m.frozenAt = m._pausedAt;
  assert.deepEqual(m.setFrozen(false), { ok: true });
  assert.equal(m.frozen, false);
  assert.equal(m.frozenAt, 0);
  assert.equal(m.paused, false, '_resume shifted the clocks back to running');
  assert.equal(m.pausedMs, 60_000, 'the frozen time is counted, like a solo pause');
  assert.equal(m._clockNow(), before, 'nothing is lost: the clock resumes where it froze');
  assert.equal(f0.rearmDeadline ?? false, false, 'the deadline flags were consumed');
  assert.equal(m.publicView().frozen, false);
  assert.equal(m.publicView().paused, false);
  // the field really resumes: the battle can end again
  h.runToEnd();
  assert.equal(f0.live, false);
  h.m.dispose();
});

test('the frozen clocks the clients follow: m.public.paused only (no second freeze flag in the runner)', () => {
  const h = coopInCombat();
  const m = h.m;
  m.setFrozen(true);
  const pub = m.publicView();
  // the browser's runner reads `paused` (client/shared runner.js setPaused(pub.paused)) and needs nothing else,
  // `frozen` is the "why" a HUD may show
  assert.equal(pub.paused, true);
  assert.equal(typeof pub.frozen, 'boolean');
  m.setFrozen(false);
  h.m.dispose();
});

test('nobody comes back in FROZEN_MS ⇒ the match is abandoned (like a solo run nobody resumes)', () => {
  // the battle must still be running when the give-up timer fires, so the scripted field never finishes by itself
  const h = coopInCombat({ script: () => ({ duration: Infinity }) });
  const m = h.m;
  m.setFrozen(true);
  assert.equal(h.ended, null);
  // not yet: one instant before the deadline
  h.sched.advance(FROZEN_MS - 1);
  assert.equal(h.ended, null, 'still held');
  assert.equal(m.frozen, true);
  // the deadline fires
  h.sched.advance(2);
  assert.equal(m.frozen, false, 'the give-up timer cleared the bookkeeping');
  assert.equal(m.frozenTimer, null, 'and cancelled itself (no leak: dispose finds no stray timer)');
  assert.equal(h.endedCount, 1, 'finish() was called exactly once');
  assert.equal(h.ended.victory, false);
  assert.equal(h.ended.reason, 'abandoned');
  assert.equal(m.phase, PHASE.RESULT);
  // the match is disposable afterwards (a room whose match ended returns to the lobby normally)
  m.dispose();
  assert.deepEqual(h.logs.error, [], 'no error logged');
});

test('a volunteer returning inside the window thaws; the give-up timer is cancelled (no stale expiry)', () => {
  const h = coopInCombat({ script: () => ({ duration: Infinity }) });
  const m = h.m;
  m.setFrozen(true);
  h.sched.advance(FROZEN_MS / 2);
  assert.deepEqual(m.setFrozen(false), { ok: true });
  assert.equal(m.frozenTimer, null, 'the timer was cancelled on thaw');
  h.sched.advance(FROZEN_MS * 2);
  assert.equal(h.ended, null, 'the running match is not abandoned by the thawed freeze');
  assert.equal(m.frozen, false);
  m.dispose();
});

test('the last volunteer leaving for good ends the match through onLeave, so the freeze never covers it', () => {
  const h = coopInCombat({ humans: 1, bots: 2 });
  const m = h.m;
  // onLeave of the only human ⇒ upstream platform.js already finishes as 'abandoned' (no non-bot, non-left player
  // remains); the freeze is for the *disconnected* volunteer whose seat is kept for the reconnect
  const r = m.setFrozen(true);
  assert.equal(r.ok, true, 'a running battle with a live field is held');
  m.setFrozen(false);
  m.handle('p_0', { t: 'g.leave' });
  assert.equal(h.ended !== null, true, 'the match ended on the leaving volunteer');
  assert.equal(h.ended.reason, 'abandoned');
  assert.equal(m.frozen, false);
  h.m.dispose();
});

test('the battle phase ending under a freeze drops the bookkeeping without thawing the clocks (_clearFrozen)', () => {
  const h = coopInCombat();
  const m = h.m;
  m.setFrozen(true);
  // the phase ends while frozen (e.g. the last field reports under a volunteer-less match)
  m._stopClientCombat();
  assert.equal(m.frozen, false, 'the bookkeeping is cleared');
  assert.equal(m.paused, false, 'and the pause with it (no resume shift: the timers are already gone)');
  assert.equal(m.frozenTimer, null, 'no stray give-up timer');
  m.dispose();
});

test('dispose while frozen leaves no stray timer behind (the freeze is tracked for dispose)', () => {
  const h = coopInCombat();
  const m = h.m;
  m.setFrozen(true);
  const carried = m._timers.size;
  assert.ok(carried >= 1, 'the give-up timer is tracked');
  m.dispose();
  // dispose stops every timer and drops the bookkeeping through _stopClientCombat → _clearFrozen: nobody is coming
  // back to resume this match, so the clocks are *not* shifted (that would need a live scheduler) — the timer is
  // simply gone. What matters is the leak: no give-up outlives the match.
  assert.equal(m._timers.size, 0, 'the give-up timer was cleared with the rest');
  assert.equal(m.frozen, false, 'no stale freeze flag survives dispose');
  assert.equal(m.disposed, true);
  assert.deepEqual(h.logs.error, [], 'no error logged');
});

// --- the volunteer-freeze holds the *busy* work too (audit C-11 / C-14, 2026-10-15) ----------------------------
//
// A server-run field in production does not sit on a deadline: it slices a headless battle in its own callbacks
// (`clientCombat.js _runOnServer` → `HeadlessJob.run(headlessSliceMs)`, ≤ 8 ms of wall clock per slice, re-armed
// with `later(0)`). Those slices are not timers with a known end instant, so a freeze that only moved the clocks
// (the pre-fix behaviour) let them keep simulating straight through the hold: the field clock passed the freeze
// instant while every client was told `paused`. `_holdCombatTimers` (pause.js) cancels them and leaves a re-arm
// closure per field (`f.rearmSlice`); the thaw runs it.

/** A co-op match whose only seats are bots (so every field is server-run) with client-combat bookkeeping on and a
 *  scripted battle longer than one slice budget. `headlessSliceMs: 8` is the production value. */
function coopServerSlicing({ script, headlessSliceMs = 8 } = {}) {
  const h = makeMatch({
    mode: 'coop', difficulty: 'FUNNY', humans: 0, bots: 2, seed: 7, fake: true,
    script: script || (() => ({ duration: 300 })), // 300 game seconds: one 8 ms slice never finishes this
    instant: false, clientCombat: true, clients: false, headlessSliceMs,
  }).start();
  h.autoHumans();
  h.drive(() => h.m.phase === PHASE.COMBAT && h.m.round === 1, { maxSteps: 3e6 });
  return h;
}

test('a server-run field is frozen mid-slice: no battle time accrues while held, the same job resumes on the thaw', () => {
  let runs = 0;
  const run = HeadlessJob.prototype.run;
  HeadlessJob.prototype.run = function (...args) { runs++; return run.apply(this, args); };
  try {
    const h = coopServerSlicing();
    const m = h.m;
    const f = m.fields.find((x) => x.live && !x.done);
    assert.ok(f, 'a live server-run field');
    assert.equal(f.cc, true, 'client-combat bookkeeping (the production path)');
    assert.equal(f.mode, 'server', 'no human seat: the server slices this field');
    // the launch state: the slice is armed and has not run yet (`later(0)` has not fired)
    assert.equal(runs, 0, 'no slice has run');
    assert.ok(f.sliceTimer, 'a slice timer is armed');
    const job = f.job;
    assert.ok(job, 'the headless job of this field');

    assert.deepEqual(m.setFrozen(true), { ok: true });
    assert.equal(f.sliceTimer, null, 'the slice timer is cancelled by the freeze');
    assert.equal(typeof f.rearmSlice, 'function', 'and leaves the continuation behind');
    assert.equal(f.job, job, 'the job survives the hold untouched');

    // three virtual seconds of hold: nothing advances (the frozen view of the clocks, and the busiest proof —
    // HeadlessJob.run is never entered while frozen, so no game time can accrue)
    m.sched.advance(3000);
    assert.equal(runs, 0, 'no slice ran while frozen');
    assert.equal(f.battle.time, 0, 'the battle has not been stepped');
    assert.equal(m._clockNow(), m.frozenAt, 'the field clock reads the hold instant');

    // the thaw: the same job is handed back to the slice loop, and the field really resumes
    assert.deepEqual(m.setFrozen(false), { ok: true });
    assert.equal(f.rearmSlice, null, 'the continuation was consumed');
    assert.equal(f.job, job, 'the same job resumes');
    assert.ok(f.sliceTimer, 'a slice timer is armed again');

    h.sched.advance(50);
    assert.ok(runs > 0, 'the slices run again after the thaw');
    h.runToEnd();
    assert.ok(h.ended, 'the match completes normally after the hold');
    assert.deepEqual(h.logs.error, [], 'no error logged');
    m.dispose();
  } finally { HeadlessJob.prototype.run = run; }
});

// A spectator's hello must not thaw a match still waiting for its volunteers (audit B, 2026-10-15): only a player
// seat brings a volunteer back. Covered at the lobby level in test/lobby.test.js (thawForReconnect).

test('a verification in flight is held across a freeze and settles the field after the thaw (SP_VERIFY=all)', () => {
  // The third busy loop the freeze must hold (pause.js _holdCombatTimers): an 'all' verification re-simulates the
  // reported result before the field may settle. Its continuation carries the verdict's inputs in closures, so the
  // hold must re-arm *that* continuation — a bare re-entry without them would run the slices and then never accept,
  // hanging the field (and, with every field waiting, the whole battle).
  const h = makeMatch({
    mode: 'coop', difficulty: 'FUNNY', humans: 1, bots: 0, seed: 345,
    clientCombat: true, clients: false, verify: 'all', headlessSliceMs: 0.000001, timerScale: 0,
  }).start();
  h.autoHumans();
  h.drive(() => h.m.phase === PHASE.COMBAT && h.m.round === 1, { maxSteps: 3e6 });
  const m = h.m;
  const f = m.fields.find((x) => x.live && !x.done);
  assert.ok(f, 'a live client-combat field');
  assert.equal(f.mode, 'client', 'the human seat is its authority');

  // what the authority reports: a server-side run of the same spec, so the verification agrees with it
  const run = runHeadless(createBattleFromSpec(f.spec, m.ds, { recordEvents: false, quiet: true }), { players: f.players });
  assert.deepEqual(m.handle('p_0', { t: 'b.result', battleId: f.battleId, result: compactResult(run.result) }), { ok: true });
  assert.equal(f.done, false, 'the result awaits verification');
  assert.ok(f.verifyJob, 'the verification is in flight');
  assert.ok(f.verifyTimer, 'and its next slice is armed');

  assert.deepEqual(m.setFrozen(true), { ok: true });
  assert.equal(f.verifyTimer, null, 'the freeze cancels the slice timer');
  assert.equal(typeof f.rearmVerify, 'function', 'and leaves the verification continuation behind');
  assert.ok(f.verifyJob, 'the re-run keeps its partially simulated battle');

  m.sched.advance(3000);
  assert.equal(m.verifyStats.checked, 0, 'no slice ran while frozen');
  assert.equal(f.done, false, 'and the field did not settle under the hold');

  assert.deepEqual(m.setFrozen(false), { ok: true });
  assert.equal(f.rearmVerify, null, 'the continuation was consumed');
  assert.ok(h.run(() => m.verifyStats.checked === 1), 'the verification finishes after the thaw');
  assert.equal(m.verifyStats.mismatches, 0, 'the honest report verifies clean');
  assert.equal(f.done, true, 'and the field settles — a hold must never strand it');
  h.runToEnd();
  assert.ok(h.ended, 'the match completes');
  assert.deepEqual(h.logs.error, [], 'no error logged');
  m.dispose();
});

// UNITE is a battle phase the freeze gate used to miss (audit fragment 2, 2026-10-15): `clientCombat.js
// _maybeFieldsDone` completes a 联防 round with COMBAT / FINAL_ASSAULT / HIDDEN_CORE, so a 联防 whose volunteers all
// vanish must hold like any other battle — otherwise the server plays that round out for nobody. The gate itself is
// what changed, so the phase is taken directly rather than played into (a 联防 round needs a specific content setup).
test('a 联防 (UNITE) battle is held too: the freeze gate covers every phase _maybeFieldsDone treats as a battle', () => {
  const h = coopInCombat();
  const m = h.m;
  const f = m.fields.find((x) => x.live && !x.done);
  assert.ok(f, 'a live field');
  const phase = m.phase;
  m.phase = PHASE.UNITE;
  assert.deepEqual(m.setFrozen(true), { ok: true }, 'UNITE is a battle phase: the hold is accepted');
  assert.equal(m.frozen, true);
  assert.equal(m.paused, true);
  m.sched.advance(3000);
  assert.equal(m._clockNow(), m.frozenAt, 'the field clock reads the hold instant');
  assert.deepEqual(m.setFrozen(false), { ok: true });
  m.phase = phase;
  assert.equal(m.frozen, false);
  h.runToEnd();
  assert.deepEqual(h.logs.error, [], 'no error logged');
  m.dispose();
});
