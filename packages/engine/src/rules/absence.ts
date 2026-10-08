// Absence resolution shared by skipSeat and the discard phase (design §5.10, ADR-0014, DR4): random auto-discards from
// the absence stream, the deterministic auto-robber, and the end of a skipped turn.
import { payToBank } from '../costs';
import type { HexId, Seat } from '../ids';
import { beginTurn, buildingOwnersOn, robberTargets, setPhase } from '../internal/turn';
import { emit } from '../log';
import { drawInt } from '../rng';
import { RESOURCES, type GameState, type Resource, type ResourceCounts } from '../state';

/**
 * Discards the cards `seat` owes in the current discard phase, chosen uniformly without replacement: each card is an
 * absence-stream index into the seat's remaining hand, expanded in canonical resource order. Logs discarded{auto:true}
 * and zeroes the seat's owed entry; the phase is otherwise unchanged (see afterDiscard).
 */
export function autoDiscard(state: GameState, seat: Seat): GameState {
  const phase = state.phase;
  if (phase.name !== 'discard') throw new Error('autoDiscard outside the discard phase');
  const owed = phase.owed[seat] ?? 0;
  const left: Resource[] = RESOURCES.flatMap((r) => Array.from({ length: state.players[seat]!.hand[r] }, () => r));
  const cards: Record<Resource, number> = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  let stream = state.rng.absence;
  for (let k = 0; k < owed; k++) {
    const [i, next] = drawInt(stream, left.length);
    stream = next;
    cards[left[i]!] += 1;
    left.splice(i, 1);
  }
  const paid = payToBank({ ...state, rng: { ...state.rng, absence: stream } }, seat, cards as ResourceCounts);
  const logged = emit(paid, { kind: 'discarded', seat, cards, auto: true });
  return setPhase(logged, { ...phase, owed: phase.owed.map((n, i) => (i === seat ? 0 : n)) });
}

/**
 * Leaves the discard phase once nobody owes: then = 'moveRobber' → moveRobber{resume:'main'} for the roller;
 * then = 'autoRobberThenEnd' (a skipped turn, DR4) → the auto-robber, then the turn ends. While someone still owes, the
 * state is returned unchanged.
 */
export function afterDiscard(state: GameState): GameState {
  const phase = state.phase;
  if (phase.name !== 'discard' || phase.owed.some((n) => n > 0)) return state;
  return phase.then === 'moveRobber'
    ? setPhase(state, { name: 'moveRobber', resume: 'main' })
    : endSkippedTurn(autoRobber(state));
}

/**
 * The auto-robber (design §5.10): no RNG, no steal, and it always moves. Over L = robberTargets(state) (canonical hex
 * order, R9 fallback included) it picks (i) the desert if it is in L, else (ii) the first hex in L with no adjacent
 * settlement or city, else (iii) the first hex in L. Logs robberMoved{seat: active, victim: null, auto: true}. The phase
 * is unchanged.
 */
export function autoRobber(state: GameState): GameState {
  const hex = autoRobberHex(state);
  return emit({ ...state, robber: hex }, { kind: 'robberMoved', seat: state.turn.active, hex, victim: null, auto: true });
}

/** The hex the auto-robber moves to. */
export function autoRobberHex(state: GameState): HexId {
  const targets = robberTargets(state);
  const desert = state.board.hexes.find((h) => h.terrain === 'desert')?.id;
  if (desert !== undefined && targets.includes(desert)) return desert;
  return targets.find((h) => buildingOwnersOn(state, h).length === 0) ?? targets[0]!;
}

/** Ends the active seat's turn as skipped: turnEnded{reason:'skipped'}, then the next seat's turn begins. */
export function endSkippedTurn(state: GameState): GameState {
  const seat = state.turn.active;
  const ended = emit(state, { kind: 'turnEnded', seat, turn: state.turn.number, reason: 'skipped' });
  return beginTurn(ended, ((seat + 1) % state.playerCount) as Seat);
}
