// Replay (design §3.4, TH8). The server's recovery path uses replayFrom.
import type { GameInit, ReduceResult, ReplayResult } from './api';
import { createGame } from './create-game';
import type { Command } from './events';
import { stateHash } from './hash';
import { reduce } from './reduce';
import type { GameState } from './state';

/** Applies `commands` in order from `state`. results[i] and hashes[i] describe the state after commands[i]; a rejected
 *  command leaves the state unchanged. */
export function replayFrom(state: GameState, commands: readonly Command[]): ReplayResult {
  let current = state;
  const results: ReduceResult[] = [];
  const hashes: string[] = [];
  for (const cmd of commands) {
    const r = reduce(current, cmd);
    if (r.ok) current = r.state;
    results.push(r);
    hashes.push(stateHash(current));
  }
  return { state: current, results, hashes };
}

/** replayFrom(createGame(init).state, commands). Throws if createGame rejects `init`. */
export function replay(init: GameInit, commands: readonly Command[]): ReplayResult {
  const created = createGame(init);
  if (!created.ok) throw new TypeError(`replay: createGame rejected the init (${created.reason})`);
  return replayFrom(created.state, commands);
}
