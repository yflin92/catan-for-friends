import { describe, expect, it } from 'vitest';
import { actionGroup, type ActionGroup, type ActionType } from './events';
import type { PhaseName } from './state';

const BY_TYPE: Record<ActionType, ActionGroup> = {
  placeSettlement: 'build', placeRoad: 'build', buildCity: 'build',
  rollDice: 'turn', endTurn: 'turn',
  discard: 'robber', moveRobber: 'robber',
  buyDevCard: 'dev', playKnight: 'dev', playRoadBuilding: 'dev', playYearOfPlenty: 'dev', playMonopoly: 'dev',
  maritimeTrade: 'trade', proposeTrade: 'trade', respondTrade: 'trade', confirmTrade: 'trade', cancelTrade: 'trade',
};
const PHASES: readonly (PhaseName | null)[] = [
  'setupSettlement', 'setupRoad', 'preRoll', 'discard', 'moveRobber', 'main', 'roadBuilding', 'gameOver', null,
];
const SETUP: readonly (PhaseName | null)[] = ['setupSettlement', 'setupRoad'];

describe('actionGroup (design v1.4 D3)', () => {
  const pairs = (Object.keys(BY_TYPE) as ActionType[]).flatMap((t) => PHASES.map((p) => [t, p] as const));

  it.each(pairs)('maps %s in phase %s', (type, phase) => {
    expect(actionGroup(type, phase)).toBe(SETUP.includes(phase) ? 'setup' : BY_TYPE[type]);
  });

  it.each(PHASES)('maps lobby, control and skipSeat the same in phase %s', (phase) => {
    expect(actionGroup('lobby', phase)).toBe('lobby');
    expect(actionGroup('control', phase)).toBe('control');
    expect(actionGroup('skipSeat', phase)).toBe('system');
  });

  it('maps setup placements to setup and later placements to build', () => {
    expect(actionGroup('placeSettlement', 'setupSettlement')).toBe('setup');
    expect(actionGroup('placeRoad', 'setupRoad')).toBe('setup');
    expect(actionGroup('placeRoad', 'roadBuilding')).toBe('build');
    expect(actionGroup('placeSettlement', 'main')).toBe('build');
  });
});
