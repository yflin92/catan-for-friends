// Victory points (design §6 R14). public = settlements + 2·cities + 2 per award held (Longest Road, Largest Army);
// total = public + the victory-point cards in hand, which stay hidden until gameOver.
import type { Seat } from './ids';
import type { GameState } from './state';

export function victoryPoints(state: GameState, seat: Seat): { readonly public: number; readonly total: number } {
  const count = (pieces: Readonly<Record<string, Seat>>) => Object.values(pieces).filter((s) => s === seat).length;
  const awards = (state.awards.longestRoad === seat ? 2 : 0) + (state.awards.largestArmy === seat ? 2 : 0);
  const publicVp = count(state.pieces.settlements) + 2 * count(state.pieces.cities) + awards;
  const cards = state.players[seat]?.devCards.filter((c) => c.kind === 'victoryPoint').length ?? 0;
  return { public: publicVp, total: publicVp + cards };
}
