// System skipSeat handler (design §5.10, ADR-0014, DR4; AC28). Runs only after the system precedence checks pass
// (malformed_action → game_over → skip_not_allowed), so the seat is one the game is waiting on: a seat that owes a
// discard, or the active seat. Clock-free: when a seat is skipped is the server's absence policy (pause_host_skip by
// default); this handler only resolves the seat's obligations.
import type { Seat } from '../ids';
import { setPhase } from '../internal/turn';
import { emit } from '../log';
import type { GameState } from '../state';
import { afterDiscard, autoDiscard, autoRobber, endSkippedTurn } from './absence';
import { rollAndProduce } from './rollDice';
import { owedOnSeven } from './seven';
import type { SystemHandler } from './types';

/** More phase steps than any turn can take; a loop that exceeds it is an engine bug. */
const MAX_STEPS = 16;

/**
 * Logs seatSkipped, then resolves the seat's obligations in phase order:
 * - a non-active seat in discard: auto-discard (absence stream); its turn does not end. If that was the last owed
 *   discard, the phase moves on as after any discard.
 * - the active seat: loops until its turn ends (or the game ends):
 *   discard → auto-discard what it owes; once nobody owes, the phase moves on; while others owe, the phase becomes
 *     discard{then:'autoRobberThenEnd'} and the turn ends after the last discard (DR4);
 *   moveRobber → auto-robber, then `resume`;
 *   preRoll → auto-roll (dice stream) with normal production and shortage. A 7 enters discard{then:'autoRobberThenEnd'}
 *     when anyone owes (the seat's own discard then resolves at once), otherwise moveRobber{resume:'main'};
 *   roadBuilding → the remaining free roads are forfeited, then `resume`;
 *   main → turnEnded{reason:'skipped'} and the next seat's turn (leaving main withdraws any open offer).
 */
export const skipSeat: SystemHandler = (state, { seat, reason }) => {
  let s = emit(state, { kind: 'seatSkipped', seat, reason });
  if (seat !== s.turn.active) return { ok: true, state: afterDiscard(autoDiscard(s, seat)) };

  const turn = s.turn.number;
  for (let step = 0; s.turn.number === turn && s.phase.name !== 'gameOver'; step++) {
    if (step >= MAX_STEPS) throw new Error('skipSeat did not end the turn');
    const phase = s.phase;
    switch (phase.name) {
      case 'discard': {
        if ((phase.owed[seat] ?? 0) > 0) s = autoDiscard(s, seat);
        const next = s.phase;
        if (next.name === 'discard' && next.owed.some((n) => n > 0)) {
          return { ok: true, state: setPhase(s, { ...next, then: 'autoRobberThenEnd' }) };
        }
        s = afterDiscard(s);
        break;
      }
      case 'moveRobber':
        s = setPhase(autoRobber(s), { name: phase.resume });
        break;
      case 'preRoll':
        s = autoRoll(s, seat);
        break;
      case 'roadBuilding':
        s = setPhase(s, { name: phase.resume });
        break;
      case 'main':
        s = endSkippedTurn(s);
        break;
      default:
        throw new Error(`skipSeat reached phase ${phase.name}`);
    }
  }
  return { ok: true, state: s };
};

/** The auto-roll of a skipped active seat: main on a non-7; on a 7, discard{then:'autoRobberThenEnd'} when anyone owes,
 *  otherwise moveRobber{resume:'main'}. */
function autoRoll(state: GameState, seat: Seat): GameState {
  const { state: rolled, seven } = rollAndProduce(state, seat, true);
  if (!seven) return setPhase(rolled, { name: 'main' });
  const owed = owedOnSeven(rolled);
  return owed.some((n) => n > 0)
    ? setPhase(rolled, { name: 'discard', owed, then: 'autoRobberThenEnd' })
    : setPhase(rolled, { name: 'moveRobber', resume: 'main' });
}
