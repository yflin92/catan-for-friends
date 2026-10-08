import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { freezeDeep } from './__fixtures__/freeze';
import { fixtureState } from './__fixtures__/state';
import type { Action, ActionType, Command } from './events';
import { checkVictory } from './internal/turn';
import { emit } from './log';
import { ReasonCode } from './reasons';
import { createReducer, reduce } from './reduce';
import { ACTION_HANDLERS } from './rules';
import { PHASE_ACTIONS } from './rules/phases';
import type { ActionHandlers, HandlerResult, SystemHandler } from './rules/types';
import type { GameState, Phase } from './state';

const ZERO = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
const ONE_BRICK = { ...ZERO, brick: 1 };

/** One well-formed example of every action type. */
const EXAMPLES: Record<ActionType, Action> = {
  placeSettlement: { type: 'placeSettlement', vertex: 'v:0,-2,N' },
  placeRoad: { type: 'placeRoad', edge: 'e:0,-2,NE' },
  buildCity: { type: 'buildCity', vertex: 'v:0,-2,N' },
  rollDice: { type: 'rollDice' },
  discard: { type: 'discard', cards: ONE_BRICK },
  moveRobber: { type: 'moveRobber', hex: 'h:0,-2', victim: null },
  buyDevCard: { type: 'buyDevCard' },
  playKnight: { type: 'playKnight' },
  playRoadBuilding: { type: 'playRoadBuilding' },
  playYearOfPlenty: { type: 'playYearOfPlenty', take: ['ore', 'ore'] },
  playMonopoly: { type: 'playMonopoly', resource: 'wool' },
  maritimeTrade: { type: 'maritimeTrade', give: 'brick', receive: 'ore', count: 1 },
  proposeTrade: { type: 'proposeTrade', give: ONE_BRICK, get: { ...ZERO, ore: 1 } },
  respondTrade: { type: 'respondTrade', tradeId: 1, accept: true },
  confirmTrade: { type: 'confirmTrade', tradeId: 1, partner: 0 },
  cancelTrade: { type: 'cancelTrade', tradeId: 1 },
  endTurn: { type: 'endTurn' },
};
const ACTION_TYPES = Object.keys(EXAMPLES) as ActionType[];

/** fixtureState: 3 players, seat 1 active, phase main. */
const withPhase = (phase: Phase, active: 0 | 1 | 2 = 1): GameState => {
  const s = fixtureState();
  return { ...s, phase, turn: { ...s.turn, active } };
};
const DISCARD: Phase = { name: 'discard', owed: [0, 4, 3], then: 'moveRobber' };
const as = (by: 0 | 1 | 2 | 3, action: Action): Command => ({ by, action });

/** Handlers that record every call and accept by returning the state unchanged. */
function recordingParts(result: (s: GameState) => HandlerResult = (s) => ({ ok: true, state: s })) {
  const calls: { type: string; seat: number | 'system' }[] = [];
  const actions = Object.fromEntries(
    ACTION_TYPES.map((t) => [t, (s: GameState, seat: number) => (calls.push({ type: t, seat }), result(s))]),
  ) as unknown as ActionHandlers;
  const system: SystemHandler = (s) => (calls.push({ type: 'skipSeat', seat: 'system' }), result(s));
  return { calls, parts: { actions, system, finalize: (s: GameState) => s } };
}

describe('reduce: malformed_action', () => {
  const s = fixtureState();
  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'endTurn'],
    ['an array', [1, { type: 'endTurn' }]],
    ['a missing action', { by: 1 }],
    ['an extra command key', { by: 1, action: { type: 'endTurn' }, actionId: 'x' }],
    ['a seat outside the game', { by: 3, action: { type: 'endTurn' } }],
    ['a non-integer seat', { by: 1.5, action: { type: 'endTurn' } }],
    ['an unknown action type', { by: 1, action: { type: 'teleport' } }],
    ['an extra action key', { by: 1, action: { type: 'endTurn', now: true } }],
    ['a missing action field', { by: 1, action: { type: 'placeRoad' } }],
    ['a wrong field type', { by: 1, action: { type: 'respondTrade', tradeId: '1', accept: true } }],
    ['a non-canonical vertex id', { by: 1, action: { type: 'placeSettlement', vertex: 'v:00,1,N' } }],
    ['a -0 hex id', { by: 1, action: { type: 'moveRobber', hex: 'h:-0,1', victim: null } }],
    ['a bad edge side', { by: 1, action: { type: 'placeRoad', edge: 'e:0,1,E' } }],
    ['counts with a missing resource', { by: 1, action: { type: 'discard', cards: { brick: 1 } } }],
    ['counts with an extra key', { by: 1, action: { type: 'discard', cards: { ...ZERO, gold: 1 } } }],
    ['a NaN count', { by: 1, action: { type: 'discard', cards: { ...ZERO, ore: Number.NaN } } }],
    ['an unknown resource', { by: 1, action: { type: 'playMonopoly', resource: 'gold' } }],
    ['a one-item Year of Plenty', { by: 1, action: { type: 'playYearOfPlenty', take: ['ore'] } }],
    ['a victim seat 4', { by: 1, action: { type: 'moveRobber', hex: 'h:0,-2', victim: 4 } }],
    ['a system command for a seat outside the game', { by: 'system', action: { type: 'skipSeat', seat: 3, reason: 'host' } }],
    ['a system command with a bad reason', { by: 'system', action: { type: 'skipSeat', seat: 1, reason: 'boredom' } }],
    ['a seat action sent as system', { by: 'system', action: { type: 'endTurn' } }],
  ])('rejects %s', (_name, cmd) => {
    expect(reduce(s, cmd as Command)).toEqual({ ok: false, reason: 'malformed_action' });
  });

  it('beats game_over', () => {
    const over = withPhase({ name: 'gameOver', winner: 1 });
    expect(reduce(over, { by: 1, action: { type: 'nope' } } as unknown as Command)).toEqual({ ok: false, reason: 'malformed_action' });
  });

  it('leaves non-integer counts and ids to the handlers (they are not shape errors)', () => {
    const { calls, parts } = recordingParts();
    const r = createReducer(parts);
    expect(r(fixtureState(), as(1, { type: 'maritimeTrade', give: 'brick', receive: 'ore', count: 1.5 })).ok).toBe(true);
    expect(r(fixtureState(), as(1, { type: 'cancelTrade', tradeId: 99.5 })).ok).toBe(true);
    expect(calls.map((c) => c.type)).toEqual(['maritimeTrade', 'cancelTrade']);
  });
});

describe('reduce: seat-command precedence (design §3.8)', () => {
  it('game_over beats everything after malformed, for any seat and action', () => {
    const over = withPhase({ name: 'gameOver', winner: 1 });
    for (const t of ACTION_TYPES) for (const seat of [0, 1, 2] as const) {
      expect(reduce(over, as(seat, EXAMPLES[t]))).toEqual({ ok: false, reason: 'game_over' });
    }
  });

  it('discard_pending beats not_your_turn and wrong_phase for every non-discard action', () => {
    const s = withPhase(DISCARD);
    for (const t of ACTION_TYPES.filter((t) => t !== 'discard')) for (const seat of [0, 1, 2] as const) {
      expect(reduce(s, as(seat, EXAMPLES[t]))).toEqual({ ok: false, reason: 'discard_pending' });
    }
  });

  it.each<[string, Phase, 0 | 1 | 2, ActionType]>([
    ['a non-active seat ending the turn', { name: 'main' }, 0, 'endTurn'],
    ['a non-active seat proposing a trade', { name: 'main' }, 2, 'proposeTrade'],
    ['a non-active seat rolling in another phase', { name: 'preRoll' }, 2, 'rollDice'],
    ['the active seat responding to a trade', { name: 'main' }, 1, 'respondTrade'],
    ['a non-active seat discarding outside discard', { name: 'main' }, 0, 'discard'],
    ['a non-active seat placing in setup', { name: 'setupSettlement', round: 1 }, 0, 'placeSettlement'],
  ])('not_your_turn: %s', (_name, phase, seat, type) => {
    expect(reduce(withPhase(phase), as(seat, EXAMPLES[type]))).toEqual({ ok: false, reason: 'not_your_turn' });
  });

  it.each<[string, Phase, 0 | 1 | 2, ActionType]>([
    ['ending the turn before rolling', { name: 'preRoll' }, 1, 'endTurn'],
    ['a second roll', { name: 'main' }, 1, 'rollDice'],
    ['building before rolling', { name: 'preRoll' }, 1, 'buildCity'],
    ['a trade response outside main', { name: 'preRoll' }, 0, 'respondTrade'],
    ['the active seat discarding in main', { name: 'main' }, 1, 'discard'],
    ['a road during setupSettlement', { name: 'setupSettlement', round: 1 }, 1, 'placeRoad'],
    ['moving the robber in main', { name: 'main' }, 1, 'moveRobber'],
    ['buying in roadBuilding', { name: 'roadBuilding', remaining: 2, resume: 'main' }, 1, 'buyDevCard'],
  ])('wrong_phase: %s', (_name, phase, seat, type) => {
    expect(reduce(withPhase(phase), as(seat, EXAMPLES[type]))).toEqual({ ok: false, reason: 'wrong_phase' });
  });

  it('calls the handler exactly when every precedence check passes', () => {
    const phases: Phase[] = [
      { name: 'setupSettlement', round: 1 }, { name: 'setupRoad', round: 2, from: 'v:0,-2,N' }, { name: 'preRoll' },
      DISCARD, { name: 'moveRobber', resume: 'main' }, { name: 'main' }, { name: 'roadBuilding', remaining: 1, resume: 'preRoll' },
    ];
    for (const phase of phases) for (const t of ACTION_TYPES) for (const seat of [0, 1, 2] as const) {
      const { calls, parts } = recordingParts();
      const res = createReducer(parts)(withPhase(phase), as(seat, EXAMPLES[t]));
      const allowed = PHASE_ACTIONS[phase.name].includes(t);
      const mayAct = t === 'respondTrade' ? seat !== 1 : t === 'discard' && phase.name === 'discard' ? true : seat === 1;
      const expectCall = allowed && mayAct && !(phase.name === 'discard' && t !== 'discard');
      expect(calls.length, `${phase.name} ${t} seat ${seat}`).toBe(expectCall ? 1 : 0);
      expect(res.ok).toBe(expectCall);
      if (expectCall) expect(calls[0]).toEqual({ type: t, seat });
    }
  });

  it('every default handler stub rejects with wrong_phase once precedence passes', () => {
    for (const t of PHASE_ACTIONS.main) {
      const seat = t === 'respondTrade' ? 0 : 1;
      expect(ACTION_HANDLERS[t](fixtureState(), seat, EXAMPLES[t] as never)).toEqual({ ok: false, reason: 'wrong_phase' });
      expect(reduce(fixtureState(), as(seat, EXAMPLES[t]))).toEqual({ ok: false, reason: 'wrong_phase' });
    }
  });
});

describe('reduce: system-command precedence (design §3.8)', () => {
  const skip = (seat: 0 | 1 | 2): Command => ({ by: 'system', action: { type: 'skipSeat', seat, reason: 'host' } });

  it('game_over beats skip_not_allowed', () => {
    expect(reduce(withPhase({ name: 'gameOver', winner: 0 }), skip(1))).toEqual({ ok: false, reason: 'game_over' });
  });

  it.each<[string, Phase, 0 | 1 | 2]>([
    ['setupSettlement', { name: 'setupSettlement', round: 1 }, 1],
    ['setupRoad', { name: 'setupRoad', round: 1, from: 'v:0,-2,N' }, 1],
    ['a non-active seat in preRoll', { name: 'preRoll' }, 0],
    ['a non-active seat in main', { name: 'main' }, 2],
    ['a seat that owes nothing in discard', DISCARD, 0],
  ])('skip_not_allowed: %s', (_name, phase, seat) => {
    const { calls, parts } = recordingParts();
    expect(createReducer(parts)(withPhase(phase), skip(seat))).toEqual({ ok: false, reason: 'skip_not_allowed' });
    expect(calls).toEqual([]);
  });

  it.each<[string, Phase, 0 | 1 | 2]>([
    ['the active seat in preRoll', { name: 'preRoll' }, 1],
    ['the active seat in main', { name: 'main' }, 1],
    ['the active seat in moveRobber', { name: 'moveRobber', resume: 'main' }, 1],
    ['the active seat in roadBuilding', { name: 'roadBuilding', remaining: 2, resume: 'main' }, 1],
    ['a non-active owing seat in discard (no discard_pending / not_your_turn)', DISCARD, 2],
    ['the active owing seat in discard', DISCARD, 1],
  ])('reaches the handler: %s', (_name, phase, seat) => {
    const { calls, parts } = recordingParts();
    expect(createReducer(parts)(withPhase(phase), skip(seat)).ok).toBe(true);
    expect(calls).toEqual([{ type: 'skipSeat', seat: 'system' }]);
  });

  it('the default skipSeat stub rejects with skip_not_allowed', () => {
    expect(reduce(withPhase({ name: 'main' }), skip(1))).toEqual({ ok: false, reason: 'skip_not_allowed' });
  });
});

describe('reduce: successful commands', () => {
  it('returns the events the handler logged, then runs finalize last', () => {
    const order: string[] = [];
    const { parts } = recordingParts((s) => {
      order.push('handler');
      return { ok: true, state: emit(emit(s, { kind: 'devBought', seat: 1 }), { kind: 'devBoughtDetail', seat: 1, card: 'monopoly' }) };
    });
    const finalize = vi.fn((s: GameState) => {
      order.push('finalize');
      expect(s.logCounter).toBe(4);
      return emit(s, { kind: 'gameOver', winner: 1, vp: [0, 10, 0] });
    });
    const before = fixtureState();
    const r = createReducer({ ...parts, finalize })(before, as(1, EXAMPLES.buyDevCard));
    expect(order).toEqual(['handler', 'finalize']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events.map((e) => e.kind)).toEqual(['devBought', 'devBoughtDetail', 'gameOver']);
    expect(r.state.log.slice(-3).map((e) => e.visibleTo)).toEqual(['all', [1], 'all']);
    expect(r.state.logCounter).toBe(before.logCounter + 3);
  });

  it('does not run finalize on a rejection', () => {
    const finalize = vi.fn((s: GameState) => s);
    const { parts } = recordingParts(() => ({ ok: false, reason: 'insufficient_resources' }));
    expect(createReducer({ ...parts, finalize })(fixtureState(), as(1, EXAMPLES.buildCity))).toEqual({
      ok: false,
      reason: 'insufficient_resources',
    });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('uses checkVictory as the default finalize step', () => {
    expect(checkVictory(fixtureState())).toEqual(fixtureState());
  });
});

describe('reduce: totality and purity (TH1)', () => {
  it('turns a throwing handler or finalize into internal_error', () => {
    const { parts } = recordingParts(() => {
      throw new Error('boom');
    });
    expect(createReducer(parts)(fixtureState(), as(1, EXAMPLES.endTurn))).toEqual({ ok: false, reason: 'internal_error' });
    const { parts: ok } = recordingParts();
    const finalize = () => {
      throw new Error('boom');
    };
    expect(createReducer({ ...ok, finalize })(fixtureState(), as(1, EXAMPLES.endTurn))).toEqual({
      ok: false,
      reason: 'internal_error',
    });
  });

  it('turns a corrupt state into internal_error instead of throwing', () => {
    const corrupt = { ...fixtureState(), phase: undefined } as unknown as GameState;
    expect(reduce(corrupt, as(1, EXAMPLES.endTurn))).toEqual({ ok: false, reason: 'internal_error' });
  });

  const engineCodes = new Set(Object.keys(ReasonCode));
  const phaseArb = fc.constantFrom<Phase>(
    { name: 'setupSettlement', round: 1 }, { name: 'preRoll' }, DISCARD, { name: 'moveRobber', resume: 'main' },
    { name: 'main' }, { name: 'roadBuilding', remaining: 1, resume: 'main' }, { name: 'gameOver', winner: 2 },
  );

  it('never throws and never mutates its input on arbitrary values (fuzz)', () => {
    fc.assert(
      fc.property(phaseArb, fc.anything(), (phase, cmd) => {
        const s = freezeDeep(withPhase(phase));
        const snapshot = JSON.stringify(s);
        const r = reduce(s, freezeDeep(cmd) as Command);
        expect(JSON.stringify(s)).toBe(snapshot);
        if (!r.ok) expect(engineCodes.has(r.reason)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('never throws on near-valid commands (fuzz)', () => {
    const valueArb = fc.oneof(
      fc.integer({ min: -2, max: 5 }), fc.double(), fc.string(), fc.boolean(), fc.constant(null),
      fc.constantFrom('v:0,-2,N', 'e:0,-2,NE', 'h:1,-2', 'ore', 'brick'), fc.constant(ONE_BRICK),
    );
    const cmdArb = fc.record({
      by: fc.oneof(fc.integer({ min: -1, max: 4 }), fc.constant('system')),
      action: fc.oneof(
        fc.constantFrom(...ACTION_TYPES).map((t) => EXAMPLES[t]),
        fc.record({ type: fc.constantFrom(...ACTION_TYPES, 'skipSeat'), seat: valueArb, reason: valueArb }),
        fc.dictionary(fc.constantFrom('type', 'vertex', 'edge', 'hex', 'victim', 'cards', 'tradeId', 'accept', 'partner', 'count'), valueArb),
      ),
    });
    fc.assert(
      fc.property(phaseArb, fc.constantFrom<0 | 1 | 2>(0, 1, 2), cmdArb, (phase, active, cmd) => {
        const s = freezeDeep(withPhase(phase, active));
        const r = reduce(s, cmd as Command);
        if (!r.ok) expect(engineCodes.has(r.reason)).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });
});
