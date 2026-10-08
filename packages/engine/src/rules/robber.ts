// Moving the robber and stealing (R9; design §5.3(4), §3.5 steal stream, AC10).
import { buildingOwnersOn, robberTargets, setPhase } from '../internal/turn';
import type { HexId, Seat } from '../ids';
import { emit } from '../log';
import { drawInt } from '../rng';
import { RESOURCES, type GameState, type Resource } from '../state';
import type { ActionHandler } from './types';

/** The seats `mover` may rob on `hex`: other seats with a building on one of its corners and ≥ 1 card, ascending. */
export function stealVictims(state: GameState, hex: HexId, mover: Seat): readonly Seat[] {
  return buildingOwnersOn(state, hex).filter(
    (s) => s !== mover && RESOURCES.some((r) => (state.players[s]?.hand[r] ?? 0) > 0),
  );
}

/**
 * 'moveRobber' action handler. Reached only by the active seat in moveRobber. Rejections, in order:
 * - robber_must_move: the robber's current hex;
 * - invalid_robber_hex: any hex not in robberTargets (off the board, or excluded by the friendly robber);
 * - invalid_steal_target: a victim not in stealVictims, or null while stealVictims is non-empty.
 * The robber moves and robberMoved{auto:false} is logged. With a victim, the steal stream draws an index into the
 * victim's hand expanded in canonical resource order; that card moves to the mover, logging stole (all) and stoleDetail
 * (thief and victim). Then the phase becomes `resume`.
 */
export const moveRobber: ActionHandler<'moveRobber'> = (state, seat, { hex, victim }) => {
  const phase = state.phase;
  if (phase.name !== 'moveRobber') return { ok: false, reason: 'wrong_phase' };
  if (hex === state.robber) return { ok: false, reason: 'robber_must_move' };
  if (!robberTargets(state).includes(hex)) return { ok: false, reason: 'invalid_robber_hex' };
  const victims = stealVictims(state, hex, seat);
  if (victim === null ? victims.length > 0 : !victims.includes(victim)) {
    return { ok: false, reason: 'invalid_steal_target' };
  }

  let s = emit({ ...state, robber: hex }, { kind: 'robberMoved', seat, hex, victim, auto: false });
  if (victim !== null) s = steal(s, seat, victim);
  return { ok: true, state: setPhase(s, { name: phase.resume }) };
};

/** Moves one card, chosen by the steal stream, from `victim`'s hand to `thief`'s and logs stole + stoleDetail. */
function steal(state: GameState, thief: Seat, victim: Seat): GameState {
  const hand = state.players[victim]!.hand;
  const cards: Resource[] = RESOURCES.flatMap((r) => Array.from({ length: hand[r] }, () => r));
  const [i, next] = drawInt(state.rng.steal, cards.length);
  const resource = cards[i]!;
  const players = state.players.map((p, j) => {
    if (j === victim) return { ...p, hand: { ...p.hand, [resource]: p.hand[resource] - 1 } };
    if (j === thief) return { ...p, hand: { ...p.hand, [resource]: p.hand[resource] + 1 } };
    return p;
  });
  const s = emit({ ...state, players, rng: { ...state.rng, steal: next } }, { kind: 'stole', seat: thief, victim });
  return emit(s, { kind: 'stoleDetail', seat: thief, victim, resource });
}
