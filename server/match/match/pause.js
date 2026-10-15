// server/match/match/pause.js — Match methods: the solo pause (g.pause, DESIGN §14 "Solo pause") — freeze, resume
// (every clock and deadline shifted by the pause), the drop at the battle phase's end, and the field clocks' "now".
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { BOSS_CLOCK_MS, OK, fail } from './common.js';

export class MatchPause {
  /**
   * Solo pause (official PauseUp / ResumeUp; DESIGN §14 "Solo pause"): g.pause { on } freezes the running battle — the
   * field clock (b.start `elapsed`, the boss budgets and overtime), the result deadline / server release timers, the
   * boss clock, the HUD `deadline` / `overtimeAt` (shifted by the pause on resume) and the server-run pacers
   * (FieldRunner / HeadlessPacer skip their intervals) — and the browser's runner stops its local clock while
   * `m.public.paused` is true. Solo matches only (co-op battles never pause: WRONG_PHASE) and only while a battle runs;
   * `{ on: false }` is always accepted. A disconnect / leave, or the battle phase ending, resumes.
   *
   * The co-op WRONG_PHASE is the *client* verdict: a co-op volunteer may never pause on request. The volunteer-freeze
   * (frozen.js) holds a co-op battle by setting `frozen` + `paused` directly — it never calls this — so that gate stays
   * exact here.
   */
  setPause(ps, on) {
    void ps;
    if (!this.isSolo) return fail(ERR.WRONG_PHASE, 'co-op battles never pause');
    if (!on) { this._resume(); return OK; }
    if (this.paused) return OK;
    const battlePhase = this.phase === PHASE.COMBAT || this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE;
    if (!battlePhase || this._finalEnding || !this.fields.some((f) => f.live && !f.done)) return fail(ERR.WRONG_PHASE, 'no battle running');
    this.paused = true;
    this._pausedAt = this.sched.now();
    this._holdCombatTimers();
    if (this._bossClock) { this.cancel(this._bossClock); this._bossClock = null; }
    this.markPublic();
    return OK;
  }

  /**
   * Hold every in-flight client-combat timer across a pause or a volunteer-freeze (frozen.js). The deadline / release
   * timers are cancelled and re-armed from their known end instants on the thaw (`_resume`), exactly as before.
   *
   * The three *busy* loops cannot be re-armed from a number, because what they resume is a partially simulated battle
   * rather than a deadline: a server-run normal / 联防 field's headless slice (`clientCombat.js _runOnServer`), a
   * result verification slice (`reports.js _verifyResult`) and a boss field's post-win result grace (`bossRounds.js
   * _endFinal`). Each is cancelled and leaves a re-arm closure on the field; the thaw runs it, so the loop picks its
   * battle up where the freeze caught it and the field clock never passes the hold instant. A closure (rather than a
   * boolean plus a switch on `f.mode`) because the three continuations live in different modules and resume different
   * objects — each closure only calls a method its own container installs (`_sliceServerField`, `_verifySliceField`,
   * `_bossWaitField`), so a missing one is a wiring bug that throws here rather than a silently dropped battle.
   */
  _holdCombatTimers() {
    for (const f of this.fields) {
      if (!f.cc || f.done) continue;
      if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; f.rearmDeadline = true; }
      if (f.doneTimer) { this.cancel(f.doneTimer); f.doneTimer = null; f.rearmRelease = true; }
      if (f.sliceTimer) { this.cancel(f.sliceTimer); f.sliceTimer = null; f.rearmSlice = this._sliceRearm(f); }
      if (f.verifyTimer) { this.cancel(f.verifyTimer); f.verifyTimer = null; f.rearmVerify = this._verifyRearm(f); }
      if (f.waitTimer) { this.cancel(f.waitTimer); f.waitTimer = null; f.rearmWait = this._waitRearm(f); }
    }
  }

  /** The still-unevaluated continuation of a field's headless slice, or null when it is not slicing right now. */
  _sliceRearm(f) {
    if (!f.job) return null;
    return () => { if (f.job) this._sliceServerField(f, f.job); };
  }

  /** The still-unevaluated continuation of a verification slice, or null when nothing is being verified. */
  _verifyRearm(f) {
    if (!f.verifyJob) return null;
    return f.verifyContinue || null;
  }

  /** The still-unevaluated continuation of a boss field's result grace, or null when the field already has a result. */
  _waitRearm(f) {
    if (f.heldResult || f.result) return null;
    return () => this._bossWaitField(f);
  }

  /** Run every held timer's re-arm closure and drop it (the thaw; `_resume` does rearmDeadline / rearmRelease first). */
  _releaseRearms() {
    for (const f of this.fields) {
      if (!f.cc) continue;
      for (const key of ['rearmSlice', 'rearmVerify', 'rearmWait']) {
        const arm = f[key];
        if (!arm) continue;
        f[key] = null;
        arm();
      }
    }
  }

  /**
   * Run a match-advancing step now, or queue it for the thaw while a volunteer-freeze holds the match.
   *
   * Holding the clocks is not enough for the steps that advance through `later(0)` chains — a PREP that found
   * everyone ready (`prep.js maybeEndPrep`), a strategy draft whose last pick landed (`phases.js finishBandDraft`),
   * a 机变 draft with no card left (`spDraft.js finishSpDraft`), an INFO_CHECK everyone confirmed
   * (`phases.js maybeEndInfo`) and a 联防 settle after its battle ended (`unitePhase.js`). Their timer fires during
   * the hold, so the *step itself* has to wait. The queue runs in order on the thaw, and each queued step re-checks
   * its own phase, so a step that became moot by then is a no-op.
   *
   * Keyed on `frozen` (not `paused`): the solo pause keeps its own semantics, where the untimed phases cannot run
   * away in the first place.
   */
  _whenThawed(fn) {
    if (!this.frozen) { fn(); return; }
    this._frozenQueue.push(fn);
  }

  /**
   * Hold the phase / turn countdowns across a pause or a volunteer-freeze. These are not per-field timers: the phase
   * deadline (`infra.js setDeadline`) and the strategy draft's turn (`phases.js startDraftTurn`) carry their callback
   * and fire instant on the match, so the thaw re-arms them with the time they had left rather than the whole
   * interval.
   */
  _holdPhaseClock() {
    if (this._phaseTimer) { this.cancel(this._phaseTimer); this._phaseTimer = null; this.rearmPhase = true; }
    if (this._turnTimer) { this.cancel(this._turnTimer); this._turnTimer = null; this.rearmTurn = true; }
  }

  /** Re-arm the countdowns `_holdPhaseClock` cancelled, each with the time it had left when the hold began. */
  _releasePhaseClock() {
    const now = this.sched.now();
    if (this.rearmPhase && this._phaseFn) {
      const fn = this._phaseFn;
      this._phaseTimer = this.later(Math.max(0, this._phaseAt - now), () => {
        this._phaseTimer = null;
        this._phaseFn = null;
        this._phaseAt = 0;
        fn();
      });
    }
    if (this.rearmTurn && this._turnFn) {
      const fn = this._turnFn;
      this._turnTimer = this.later(Math.max(0, this._turnAt - now), () => {
        this._turnTimer = null;
        this._turnFn = null;
        this._turnAt = 0;
        fn();
      });
    }
    this.rearmPhase = false;
    this.rearmTurn = false;
  }

  /** Run the steps the hold queued (`_whenThawed`), so the match picks up exactly where the freeze caught it. */
  _releaseFrozenQueue() {
    if (!this._frozenQueue.length) return;
    const queued = this._frozenQueue;
    this._frozenQueue = [];
    for (const fn of queued) this.later(0, fn);
  }

  /** End a solo pause or a volunteer-freeze: every clock and deadline moves on by the held time (no-op when running). */
  _resume() {
    if (!this.paused) return;
    const d = Math.max(0, this.sched.now() - this._pausedAt);
    this.paused = false;
    this._pausedAt = 0;
    this.pausedMs += d;
    if (this.deadline) this.deadline += d;
    if (this.overtimeAt) this.overtimeAt += d;
    if (this._bossStartAt != null) this._bossStartAt += d;
    if (this._phaseAt) this._phaseAt += d;
    if (this._turnAt) this._turnAt += d;
    if (this.draft && this.draft.turnDeadline) this.draft.turnDeadline += d;
    if (this.sp && this.sp.turnDeadline) this.sp.turnDeadline += d;
    for (const f of this.fields) {
      if (!f.cc || f.done) continue;
      f.startAt += d;
      f.lastProgressAt += d;
      if (f.rearmDeadline && f.mode === 'client') this._armDeadline(f);
      if (f.rearmRelease && f.mode === 'server') this._armRelease(f);
      f.rearmDeadline = false;
      f.rearmRelease = false;
    }
    this._releasePhaseClock(); // the phase / turn countdowns continue with the time they had left
    this._releaseRearms(); // the held slices / verifications / result graces continue where the freeze caught them
    this._releaseFrozenQueue(); // the steps that came due under the hold run now
    if (this._bossClockOn && !this._bossClock && (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE)) {
      this._bossClock = this.later(BOSS_CLOCK_MS, () => this._bossClockTick());
    }
    if (this.runner?.remote) this.runner.resume();
    this.markPublic();
  }

  /** The battle phase is over: drop the pause without shifting anything (its timers are gone). */
  _clearPause() {
    if (!this.paused) return;
    this.pausedMs += Math.max(0, this.sched.now() - this._pausedAt);
    this.paused = false;
    this._pausedAt = 0;
    this.markPublic();
  }

  /** The field clocks' "now": frozen at the pause instant while paused. */
  _clockNow() { return this.paused ? this._pausedAt : this.sched.now(); }
}
