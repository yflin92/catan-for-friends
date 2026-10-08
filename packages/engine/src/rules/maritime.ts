// Maritime (bank and harbor) trade ratios (design §6 R13, AC16).
import type { Seat } from '../ids';
import { RESOURCES, type GameState, type Resource } from '../state';
import { STANDARD_TOPOLOGY } from '../topology';
import { buildingAt } from './placement';
import type { LegalSlice, RuleModule } from './types';

export type MaritimeRatio = 2 | 3 | 4;

/**
 * The rate at which `seat` gives `give` to the bank for one card: 2 with its own `give` harbor, else 3 with a generic
 * harbor, else 4. Only the harbor for the given resource gives 2:1; 2:1 harbors for other resources do not apply. A
 * seat owns a harbor when it has a settlement or city on either vertex of the harbor's edge.
 */
export function maritimeRatio(state: GameState, seat: Seat, give: Resource): MaritimeRatio {
  let generic = false;
  for (const { edge, kind } of state.board.harbors) {
    if (!STANDARD_TOPOLOGY.edgeVertices(edge).some((v) => buildingAt(state, v) === seat)) continue;
    if (kind === give) return 2;
    if (kind === 'generic') generic = true;
  }
  return generic ? 3 : 4;
}

/** legal.maritime: for the active seat in main, each give-resource whose ratio the hand covers at least once. */
export const maritimeSlice: LegalSlice = (state, seat) => {
  if (state.phase.name !== 'main' || seat !== state.turn.active) return {};
  const hand = state.players[seat]!.hand;
  const maritime: Partial<Record<Resource, MaritimeRatio>> = {};
  for (const r of RESOURCES) {
    const ratio = maritimeRatio(state, seat, r);
    if (hand[r] >= ratio) maritime[r] = ratio;
  }
  return { maritime };
};

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { slice: maritimeSlice };
