// Self-tests of the E-INT assertion helpers: each must flag a fabricated bad state or step, so a passing walker or
// golden run means something.
import { describe, expect, it } from 'vitest';
import type { Command } from '../events';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import type { GameState } from '../state';
import { buildState } from '../testing';
import { describes, expectedTurnCode, winnerIssues } from './oracle';
import { v39StateIssues, v39StepIssues } from './v39';
import { playout } from './walk';
import { probeIssues } from './walker';

function apply(s: GameState, cmd: Command): GameState {
  const r = reduce(s, cmd);
  if (!r.ok) throw new Error(`rejected: ${r.reason}`);
  return r.state;
}

describe('winnerIssues (gameOver: winner = active seat, VP ≥ vpTarget)', () => {
  it('holds at a gameOver reached by a seeded playout', () => {
    const over = [1, 2, 3, 5, 6, 7].map((seed) => playout({ seed, playerCount: 4, maxSteps: 2000, greed: 0.8 }).final).find((s) => s.phase.name === 'gameOver');
    expect(over).toBeDefined();
    expect(winnerIssues(over!)).toEqual([]);
  });

  it('flags a fabricated gameOver whose winner is not active and below the target', () => {
    const bad = buildState({ phase: { name: 'gameOver', winner: 1 }, turn: { active: 0 } });
    expect(winnerIssues(bad).map((i) => i.code)).toEqual(['winner_not_active', 'winner_below_target']);
  });

  it('ignores states outside gameOver', () => {
    expect(winnerIssues(buildState({}))).toEqual([]);
  });
});

describe('V39 relation self-tests', () => {
  const main = buildState({ turn: { number: 3 } });
  const endTurn: Command = { by: 0, action: { type: 'endTurn' } };
  const after = apply(main, endTurn);

  it('accepts the real step', () => {
    expect(v39StepIssues(main, endTurn, after)).toEqual([]);
  });

  it('flags an endTurn that does not advance the active seat or leaves devPlayed set', () => {
    expect(v39StepIssues(main, endTurn, { ...after, turn: { ...after.turn, active: 0 } }).join()).toMatch(/active → next/);
    expect(v39StepIssues(main, endTurn, { ...after, turn: { ...after.turn, devPlayed: true } }).join()).toMatch(/devPlayed → false/);
  });

  it('flags a Knight that does not record its return phase, and a step by an ineligible seat', () => {
    const s = buildState({ devCards: { 0: [{ kind: 'knight', boughtOnTurn: 0 }] }, turn: { number: 3 } });
    const knight: Command = { by: 0, action: { type: 'playKnight' } };
    const post = apply(s, knight);
    expect(v39StepIssues(s, knight, post)).toEqual([]);
    expect(v39StepIssues(s, knight, { ...post, phase: { name: 'moveRobber', resume: 'preRoll' } }).join()).toMatch(/moveRobber\(main\)/);
    expect(v39StepIssues(s, { ...knight, by: 1 }, post).join()).toMatch(/seat 1 is eligible/);
  });

  it('flags model invariant violations: an offer outside main, discard without owed cards, an unclaimed win', () => {
    const offer = { id: 1, from: 0, give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }, get: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 1 }, responses: ['self', 'pending', 'pending', 'pending'] } as const;
    expect(v39StateIssues({ ...main, phase: { name: 'preRoll' }, trade: offer }).join()).toMatch(/OfferOnlyInMain/);
    expect(v39StateIssues({ ...main, phase: { name: 'discard', owed: [0, 0, 0, 0], then: 'moveRobber' } }).join()).toMatch(/DiscardIffOwed/);
    expect(v39StateIssues({ ...main, config: { ...main.config, vpTarget: 0 } }).join()).toMatch(/NoUnclaimedWin/);
  });
});

describe('legal ⇔ reduce probe self-tests', () => {
  const s = buildState({ turn: { number: 3 }, hands: { 0: { brick: 1, lumber: 1 } } });

  it('describes() matches the descriptor exactly, with YoP as a multiset', () => {
    const legal = legalActions(s, 0);
    expect(describes(s, 0, legal, { type: 'endTurn' })).toBe(true);
    expect(describes(s, 0, legal, { type: 'rollDice' })).toBe(false);
    const yop = { ...legal, playYearOfPlenty: [['brick', 'ore']] as const };
    expect(describes(s, 0, yop, { type: 'playYearOfPlenty', take: ['ore', 'brick'] })).toBe(true);
    expect(describes(s, 0, yop, { type: 'playYearOfPlenty', take: ['ore', 'ore'] })).toBe(false);
  });

  it('expectedTurnCode follows D18a: discard_pending → not_your_turn (role) → wrong_phase', () => {
    const discard = buildState({ phase: { name: 'discard', owed: [0, 4, 0, 0], then: 'moveRobber' }, hands: { 1: { ore: 8 } } });
    expect(expectedTurnCode(discard, 0, 'endTurn')).toBe('discard_pending');
    expect(expectedTurnCode(s, 1, 'rollDice')).toBe('not_your_turn'); // role before phase
    expect(expectedTurnCode(s, 0, 'respondTrade')).toBe('not_your_turn');
    expect(expectedTurnCode(s, 2, 'discard')).toBe('wrong_phase'); // a discard outside the discard phase, any seat
    expect(expectedTurnCode(s, 0, 'rollDice')).toBe('wrong_phase');
    expect(expectedTurnCode(s, 0, 'endTurn')).toBeNull();
  });

  it('probeIssues is clean on real reduce, and reports a turn code that contradicts D18a', () => {
    expect(probeIssues(s, 1, { type: 'rollDice' })).toEqual([]);
    expect(probeIssues(s, 0, { type: 'placeRoad', edge: 'e:0,0,NE' })).toEqual([]);
    // In a discard phase every non-discard action is discard_pending, whoever sends it.
    const discard = buildState({ phase: { name: 'discard', owed: [0, 4, 0, 0], then: 'moveRobber' }, hands: { 1: { ore: 8 } } });
    expect(probeIssues(discard, 2, { type: 'endTurn' })).toEqual([]);
    expect(probeIssues({ ...discard, phase: { name: 'main' } }, 2, { type: 'endTurn' })).toEqual([]);
  });
});
