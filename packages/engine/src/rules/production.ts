// Production (R8, design §6 "Production and bank shortage"). Each hex whose token equals the roll and that does not
// hold the robber pays 1 per adjacent settlement and 2 per adjacent city. Shortage is decided per resource: when the
// bank holds less of a resource than the total owed, a single owed seat takes everything the bank has, and with two
// or more owed seats nobody receives it.
import type { Seat } from '../ids';
import type { GameState, Resource, ResourceCounts } from '../state';
import { RESOURCES, TERRAIN_YIELD } from '../state';
import { STANDARD_TOPOLOGY as T } from '../topology';

const ZERO: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

export interface Production {
  /** What each seat receives, indexed by seat. */
  readonly gains: readonly ResourceCounts[];
  /** Resources the bank could not pay in full, in canonical order. */
  readonly shortage: readonly Resource[];
}

/** What each seat is owed for `roll`, before the bank-shortage rule. */
export function owedFor(state: GameState, roll: number): ResourceCounts[] {
  const owed: Record<Resource, number>[] = Array.from({ length: state.playerCount }, () => ({ ...ZERO }));
  for (const hex of state.board.hexes) {
    if (hex.token !== roll || hex.id === state.robber || hex.terrain === 'desert') continue;
    const r = TERRAIN_YIELD[hex.terrain];
    for (const v of T.hexCorners(hex.id)) {
      const settler = state.pieces.settlements[v];
      const citizen = state.pieces.cities[v];
      if (settler !== undefined) owed[settler]![r] += 1;
      if (citizen !== undefined) owed[citizen]![r] += 2;
    }
  }
  return owed;
}

/** Applies the per-resource bank-shortage rule to `owed`. */
export function produce(state: GameState, roll: number): Production {
  const owed = owedFor(state, roll);
  const gains = owed.map((o) => ({ ...o }));
  const shortage: Resource[] = [];
  for (const r of RESOURCES) {
    const total = owed.reduce((n, o) => n + o[r], 0);
    if (total <= state.bank[r]) continue;
    shortage.push(r);
    const owedSeats = owed.map((o, seat) => [seat, o[r]] as const).filter(([, n]) => n > 0);
    for (const g of gains) g[r] = 0;
    if (owedSeats.length === 1) gains[owedSeats[0]![0]]![r] = state.bank[r];
  }
  return { gains, shortage };
}

/** Moves the production gains from the bank into the hands. */
export function payProduction(state: GameState, gains: readonly ResourceCounts[]): GameState {
  const bank = { ...state.bank } as Record<Resource, number>;
  const players = state.players.map((p, seat) => {
    const g = gains[seat as Seat];
    if (g === undefined) return p;
    const hand = { ...p.hand } as Record<Resource, number>;
    for (const r of RESOURCES) {
      hand[r] += g[r];
      bank[r] -= g[r];
    }
    return { ...p, hand };
  });
  return { ...state, bank, players };
}
