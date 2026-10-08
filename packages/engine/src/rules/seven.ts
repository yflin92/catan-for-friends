// What a rolled 7 starts (R9). Currently the robber move only: no discards are collected yet, and the phase becomes
// moveRobber, returning to main afterwards.
import { setPhase } from '../internal/turn';
import type { GameState } from '../state';

export function startSeven(state: GameState): GameState {
  return setPhase(state, { name: 'moveRobber', resume: 'main' });
}
