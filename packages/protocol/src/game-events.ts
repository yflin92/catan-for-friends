// The log event kinds this protocol build knows, and a guard that separates them from UnknownGameEvent.
import type { GameEvent } from '@hexlands/engine';
import type { UnknownGameEvent } from './messages';

const KINDS: Readonly<Record<GameEvent['kind'], true>> = {
  diceRolled: true,
  setupResources: true,
  built: true,
  discarded: true,
  robberMoved: true,
  stole: true,
  stoleDetail: true,
  devBought: true,
  devBoughtDetail: true,
  devPlayed: true,
  maritimeTraded: true,
  tradeProposed: true,
  tradeResponded: true,
  tradeResolved: true,
  awardChanged: true,
  seatSkipped: true,
  turnEnded: true,
  gameOver: true,
};

export const GAME_EVENT_KINDS: readonly GameEvent['kind'][] = Object.freeze(Object.keys(KINDS) as GameEvent['kind'][]);

export function isKnownGameEvent(e: GameEvent | UnknownGameEvent): e is GameEvent {
  return Object.prototype.hasOwnProperty.call(KINDS, e.kind);
}
