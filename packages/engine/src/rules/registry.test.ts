import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME_CONFIG } from '../config';
import { createGame } from '../create-game';
import type { ActionType } from '../events';
import type { Seat } from '../ids';
import { createLegalActions, legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import type { GameState } from '../state';
import { sampleLegalAction } from '../testing';
import { ACTION_HANDLERS, LEGAL_SLICES, RULE_MODULES } from './index';
import { PHASE_ACTIONS } from './phases';
import { collectHandlers, notImplemented, type ActionHandler, type RuleModule } from './types';

const ACTION_TYPES: readonly ActionType[] = [...new Set(Object.values(PHASE_ACTIONS).flat())];
/** The LegalActions field describing each action type. */
const FIELD: Readonly<Record<ActionType, string>> = Object.freeze(
  Object.fromEntries(ACTION_TYPES.map((t) => [t, t === 'maritimeTrade' ? 'maritime' : t])) as Record<ActionType, string>,
);

/** States from seeded random games (every phase is visited), for each seat. */
function walkStates(seeds: readonly string[], steps: number): GameState[] {
  const out: GameState[] = [];
  for (const seed of seeds) {
    let rngState = 0x9e3779b9 ^ seed.length;
    const rand = () => ((rngState = (Math.imul(rngState ^ (rngState >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
    const created = createGame({ config: DEFAULT_GAME_CONFIG.rules, playerCount: 4, seed });
    if (!created.ok) throw new Error('createGame failed');
    let s = created.state;
    for (let i = 0; i < steps && s.phase.name !== 'gameOver'; i++) {
      out.push(s);
      const seats = ([0, 1, 2, 3] as Seat[]).filter((seat) => sampleLegalAction(s, seat, () => 0) !== null);
      const seat = seats[Math.floor(rand() * seats.length)];
      if (seat === undefined) break;
      const action = sampleLegalAction(s, seat, rand);
      if (action === null) break;
      const r = reduce(s, { by: seat, action });
      if (r.ok) s = r.state;
    }
  }
  return out;
}

describe('rule registry (HARD-1: self-registration)', () => {
  it('every action type has exactly one registered handler; skipSeat is the system-only command', () => {
    for (const t of ACTION_TYPES) {
      const owners = RULE_MODULES.filter((m) => m.handlers?.[t] !== undefined);
      expect(owners, t).toHaveLength(1);
      expect(ACTION_HANDLERS[t]).toBe(owners[0]!.handlers![t]);
    }
    expect(Object.keys(ACTION_HANDLERS).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it('LEGAL_SLICES are exactly the registered slices', () => {
    expect(LEGAL_SLICES).toEqual(RULE_MODULES.flatMap((m) => (m.slice ? [m.slice] : [])));
    expect(LEGAL_SLICES.length).toBeGreaterThan(0);
  });

  it('collectHandlers refuses two handlers for one type and stubs a type nobody handles (wrong_phase)', () => {
    const h: ActionHandler<'endTurn'> = () => notImplemented;
    const twice: RuleModule[] = [{ handlers: { endTurn: h } }, { handlers: { endTurn: h } }];
    expect(() => collectHandlers(twice, ['endTurn'])).toThrow('two handlers for endTurn');
    const stubbed = collectHandlers([], ['endTurn']);
    expect(stubbed.endTurn({} as GameState, 0, { type: 'endTurn' })).toEqual({ ok: false, reason: 'wrong_phase' });
  });

  const states = walkStates(['reg-a', 'reg-b', 'reg-c'], 400);

  it('the random games visit every phase', () => {
    const phases = new Set(states.map((s) => s.phase.name));
    for (const p of ['setupSettlement', 'setupRoad', 'preRoll', 'main', 'discard', 'moveRobber']) expect(phases.has(p as never), p).toBe(true);
  });

  it('slices are field-disjoint for every visited state and seat, so their merge order is irrelevant', () => {
    for (const s of states) {
      for (const seat of [0, 1, 2, 3] as Seat[]) {
        const seen = new Map<string, number>();
        LEGAL_SLICES.forEach((slice, i) => {
          for (const key of Object.keys(slice(s, seat))) {
            expect(seen.has(key), `${s.phase.name} seat ${seat}: ${key} from slices ${seen.get(key)} and ${i}`).toBe(false);
            seen.set(key, i);
          }
        });
      }
    }
  });

  it('legalActions is identical with the slices merged in reverse order', () => {
    const reversed = createLegalActions([...LEGAL_SLICES].reverse());
    for (const s of states) {
      for (const seat of [0, 1, 2, 3] as Seat[]) expect(JSON.stringify(reversed(s, seat))).toBe(JSON.stringify(legalActions(s, seat)));
    }
  });

  it('every action type’s legal field is produced by some slice', () => {
    const produced = new Set<string>();
    for (const s of states) for (const seat of [0, 1, 2, 3] as Seat[]) for (const slice of LEGAL_SLICES) for (const k of Object.keys(slice(s, seat))) produced.add(k);
    for (const t of ACTION_TYPES) expect(produced.has(FIELD[t]), `${t} → ${FIELD[t]}`).toBe(true);
  });
});
