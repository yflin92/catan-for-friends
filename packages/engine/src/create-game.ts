// createGame (design §3.4). Board generation, the dev-deck shuffle and stream seeding land with the board-generation
// track; until then every init is rejected.
import type { GameInit } from './api';
import type { GameState } from './state';

export function createGame(init: GameInit): { ok: true; state: GameState } | { ok: false; reason: 'malformed_action' } {
  void init;
  return { ok: false, reason: 'malformed_action' };
}
