// The seats the game is waiting on (absence policy, system-command precedence). The turn-machine track refines this.
import type { Seat } from './ids';
import type { GameState } from './state';

/** gameOver → none; discard → every seat that still owes cards (ascending); otherwise the active seat. */
export function eligibleSeats(state: GameState): readonly Seat[] {
  switch (state.phase.name) {
    case 'gameOver':
      return [];
    case 'discard': {
      const owed = state.phase.owed;
      return ([0, 1, 2, 3] as const).filter((s) => s < state.playerCount && (owed[s] ?? 0) > 0);
    }
    default:
      return [state.turn.active];
  }
}
