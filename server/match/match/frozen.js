// server/match/match/frozen.js — Match methods: the volunteer-freeze (all real players gone → frozen, DESIGN §14).
//
// A co-op match never pauses on request (`pause.js`: "co-op battles never pause" stands for the human g.pause), but
// the volunteers may all disconnect at once. Then the match holds: the fields stop, the clocks stop with them, and
// the room is not disposed — a volunteer may still reconnect (`net.js` keeps the seat for the reconnect window) and
// pick the battle up where it stopped. If nobody comes back in time, or the last volunteer leaves for good, the
// match is abandoned (`finish('abandoned')`, like a resigned solo run: no m.result, the clients see "simulation
// closed" — see Replay Record in server/lobby.js).
//
// This module owns the freeze's *events* only. The freeze itself reuses MatchPause wholesale — `this.paused` /
// `_pausedAt` / `_clockNow()` / the shifted clocks of `_resume()` — so a volunteer-freeze and the solo pause freeze
// the clock the same way and `_resume()` thaws both. What is frozen-specific is the trigger (no connected human),
// the deadline (frozenAt + FROZEN_MS), and what happens when it runs out.
//
// `frozenAt` is 0 while running; it is the scheduler instant the freeze began while frozen. `frozenTimer` is the
// give-up timer (null when none is armed). Installed on Match.prototype by server/match/Match.js (a method
// container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { OK, fail } from './common.js';

/** Wall-clock ms a volunteer-less co-op match stays held before it is abandoned. */
export const FROZEN_MS = 10 * 60_000;

/** The phases a volunteer-freeze may hold (the same battle phases the solo pause may). */
function isBattlePhase(phase) {
  // UNITE is a battle phase too (clientCombat.js _maybeFieldsDone completes it with the other three): a 联防 round
  // whose volunteers all vanish must hold like any other battle.
  return phase === PHASE.COMBAT || phase === PHASE.UNITE || phase === PHASE.FINAL_ASSAULT || phase === PHASE.HIDDEN_CORE;
}

export class MatchFrozen {
  /**
   * Freeze or thaw a volunteer-less co-op match. Called by the room (server/lobby.js) when the last connected
   * volunteer leaves or comes back, never by a client: `{ on: true }` holds the running battle, `{ on: false }`
   * resumes it (`_resume()` shifts the clocks by the frozen time, so nothing is lost). A solo match is left to its
   * own pause (the room never calls this for one), and a battle-less phase is never frozen (the match advances
   * normally instead). Returns OK (idempotent) or a failure.
   * @param {boolean} on
   * @returns {{ ok: true }|{ error: string, detail?: string }}
   */
  setFrozen(on) {
    if (!on) return this._unfreeze();
    if (this.frozen) return OK;
    if (this.isSolo) return fail(ERR.WRONG_PHASE, 'solo matches use the pause');
    if (!isBattlePhase(this.phase) || this._finalEnding) return fail(ERR.WRONG_PHASE, 'no battle running');
    if (!this.fields.some((f) => f.live && !f.done)) return fail(ERR.WRONG_PHASE, 'no battle running');
    this.frozen = true;
    this.frozenAt = this.sched.now();
    // The same clocks the solo pause freezes: the deadline / release timers are cancelled and re-armed on the thaw
    // (pause.js _holdCombatTimers / _resume), so nothing here repeats them — and the headless slices, the result
    // verifications and a boss field's result grace are held the same way, so the field clock never passes the hold.
    this.paused = true;
    this._pausedAt = this.frozenAt;
    this._holdCombatTimers();
    if (this._bossClock) { this.cancel(this._bossClock); this._bossClock = null; }
    this.frozenTimer = this.later(FROZEN_MS, () => this._frozenExpire());
    this.log.info?.(`[match] ${this.roomCode} frozen: no connected volunteer`);
    this.markPublic();
    return OK;
  }

  /** Thaw a frozen match (idempotent; no-op when it is not frozen). The clocks move on by the frozen time. */
  _unfreeze() {
    if (!this.frozen) return OK;
    this.frozen = false;
    this.frozenAt = 0;
    if (this.frozenTimer) { this.cancel(this.frozenTimer); this.frozenTimer = null; }
    this.log.info?.(`[match] ${this.roomCode} resumed: a volunteer is back`);
    this._resume(); // shifts every clock by the frozen time (pause.js); returns nothing
    return OK;
  }

  /** The freeze's deadline ran out: abandon the match, like a solo run nobody resumes. */
  _frozenExpire() {
    this.frozenTimer = null;
    if (!this.frozen) return;
    this.log.info?.(`[match] ${this.roomCode} abandoned: frozen for ${FROZEN_MS} ms with no volunteer`);
    this.finish({ victory: false, reason: 'abandoned' });
  }

  /**
   * Drop the freeze without thawing the clocks (the battle phase ended under it): only the bookkeeping.
   *
   * Called from `_stopClientCombat` (clientCombat.js) — the phase end, `finish()` and `dispose()` alike — so the
   * give-up timer never outlives what it was timing. Nothing is resumed here: the frozen clocks stay frozen until
   * `_clearPause`'s own verdict, and the timers this freeze held were already cancelled by the caller.
   */
  _clearFrozen() {
    if (!this.frozen) return;
    this.frozen = false;
    this.frozenAt = 0;
    if (this.frozenTimer) { this.cancel(this.frozenTimer); this.frozenTimer = null; }
  }
}
