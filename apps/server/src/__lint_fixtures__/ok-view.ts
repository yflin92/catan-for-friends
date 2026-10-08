// Allowed: PlayerViews created by view(state, seat), and generic helpers applied to an existing PlayerView (HARD-1).
import { view, type GameState, type PlayerView, type Seat } from '@hexlands/engine';

function identity<T>(x: T): T {
  return x;
}

export function make(state: GameState): PlayerView {
  const v: PlayerView = view(state, 0);
  const same: PlayerView = identity(v);
  return structuredClone(same);
}

// Collections and promises of existing views: the generic's input already holds the PlayerView.
export async function collections(state: GameState, bySeat: Map<Seat, PlayerView>): Promise<PlayerView | undefined> {
  const views = [view(state, 0), view(state, 1)];
  const copies: PlayerView[] = Array.from(views);
  const first: PlayerView | undefined = copies.find((v) => v.devDeckCount > 0);
  const fromMap: PlayerView | undefined = bySeat.get(0);
  const box: { v: PlayerView } = { v: views[0]! };
  const all = await Promise.all(views.map((v) => Promise.resolve(v)));
  return first ?? fromMap ?? box.v ?? all[0];
}
