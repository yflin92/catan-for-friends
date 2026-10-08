import { describe, expect, it } from 'vitest';
import { actionGroup, type ActionType } from './events';

describe('actionGroup', () => {
  it.each<[ActionType | 'skipSeat' | 'lobby', string]>([
    ['placeSettlement', 'build'], ['placeRoad', 'build'], ['buildCity', 'build'],
    ['rollDice', 'turn'], ['endTurn', 'turn'],
    ['discard', 'robber'], ['moveRobber', 'robber'],
    ['buyDevCard', 'dev'], ['playKnight', 'dev'], ['playRoadBuilding', 'dev'], ['playYearOfPlenty', 'dev'], ['playMonopoly', 'dev'],
    ['maritimeTrade', 'trade'], ['proposeTrade', 'trade'], ['respondTrade', 'trade'], ['confirmTrade', 'trade'], ['cancelTrade', 'trade'],
    ['skipSeat', 'system'], ['lobby', 'lobby'],
  ])('maps %s to %s', (type, group) => {
    expect(actionGroup(type)).toBe(group);
  });
});
