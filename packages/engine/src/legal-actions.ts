// The legalActions aggregator (design §3.6): merges the slices contributed by each rule track.
import { eligibleSeats } from './eligible';
import type { Seat } from './ids';
import type { LegalActions } from './legal';
import { LEGAL_SLICES } from './rules';
import type { LegalSlice } from './rules/types';
import type { GameState } from './state';

function emptyLegal(state: GameState, seat: Seat): LegalActions {
  return {
    seat,
    phase: state.phase.name,
    placeSettlement: [],
    placeRoad: [],
    buildCity: [],
    rollDice: false,
    endTurn: false,
    buyDevCard: false,
    playKnight: false,
    playRoadBuilding: false,
    playYearOfPlenty: [],
    playMonopoly: false,
    discard: null,
    moveRobber: [],
    maritime: {},
    bankStock: state.bank,
    proposeTrade: false,
    respondTrade: null,
    confirmTrade: null,
    cancelTrade: null,
  };
}

/**
 * Builds legalActions from `slices`, in order. A seat the game is not waiting on keeps only respondTrade, and only
 * when it is not the active seat (AC11); every other field stays empty/false/null.
 */
export function createLegalActions(slices: readonly LegalSlice[]): (state: GameState, seat: Seat) => LegalActions {
  return (state, seat) => {
    const base = emptyLegal(state, seat);
    if (state.phase.name === 'gameOver') return base;
    let merged: LegalActions = base;
    for (const slice of slices) merged = { ...merged, ...slice(state, seat) };
    const respondTrade = seat !== state.turn.active ? merged.respondTrade : null;
    if (!eligibleSeats(state).includes(seat)) return { ...base, respondTrade };
    return { ...merged, seat, phase: base.phase, bankStock: base.bankStock, respondTrade };
  };
}

const defaultLegalActions = createLegalActions(LEGAL_SLICES);

/** What `seat` may do now. An action is described here iff reduce accepts it (AC6, V11). */
export function legalActions(state: GameState, seat: Seat): LegalActions {
  return defaultLegalActions(state, seat);
}
