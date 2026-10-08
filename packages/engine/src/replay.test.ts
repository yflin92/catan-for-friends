import { describe, expect, it } from 'vitest';
import { fixtureState } from './__fixtures__/state';
import type { Command } from './events';
import { stateHash } from './hash';
import { reduce } from './reduce';
import type { GameInit } from './api';
import { DEFAULT_GAME_CONFIG } from './config';
import { createGame } from './create-game';
import { replay, replayFrom } from './replay';
import type { GameState } from './state';

const COMMANDS: readonly Command[] = [
  { by: 1, action: { type: 'buildCity', vertex: 'v:-1,2,S' } },
  { by: 0, action: { type: 'endTurn' } },
  { by: 'system', action: { type: 'skipSeat', seat: 1, reason: 'host' } },
  { by: 2, action: { type: 'respondTrade', tradeId: 1, accept: false } },
  { by: 1, action: { type: 'nope' } } as unknown as Command,
];

describe('replayFrom (TH8)', () => {
  it('returns one result and one hash per command, hashes[i] taken after commands[i]', () => {
    const start = fixtureState();
    const r = replayFrom(start, COMMANDS);
    expect(r.results).toHaveLength(COMMANDS.length);
    expect(r.hashes).toHaveLength(COMMANDS.length);
    let s: GameState = start;
    COMMANDS.forEach((cmd, i) => {
      const step = reduce(s, cmd);
      if (step.ok) s = step.state;
      expect(r.results[i]).toEqual(step);
      expect(r.hashes[i]).toBe(stateHash(s));
    });
    expect(r.state).toEqual(s);
  });

  it('is deterministic: the same start and commands give identical results and hashes', () => {
    const a = replayFrom(fixtureState(), COMMANDS);
    const b = replayFrom(JSON.parse(JSON.stringify(fixtureState())) as GameState, COMMANDS);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.results).toEqual(a.results);
  });

  it('leaves the state (and its hash) unchanged across rejected commands', () => {
    const start = fixtureState();
    const r = replayFrom(start, COMMANDS);
    expect(r.results.every((x) => !x.ok)).toBe(true);
    expect(new Set(r.hashes)).toEqual(new Set([stateHash(start)]));
    expect(r.state).toBe(start);
  });

  it('handles an empty command list', () => {
    const start = fixtureState();
    expect(replayFrom(start, [])).toEqual({ state: start, results: [], hashes: [] });
  });
});

describe('replay (init, commands)', () => {
  const INIT: GameInit = { config: DEFAULT_GAME_CONFIG.rules, playerCount: 4, seed: 'replay-seed' };
  const SEEDED: readonly Command[] = [
    { by: 0, action: { type: 'placeSettlement', vertex: 'v:0,0,N' } },
    { by: 0, action: { type: 'placeRoad', edge: 'e:0,0,NE' } },
    { by: 1, action: { type: 'endTurn' } },
    { by: 'system', action: { type: 'skipSeat', seat: 0, reason: 'timer' } },
  ];

  it('equals replayFrom(createGame(init).state, commands) for a seeded init', () => {
    const created = createGame(INIT);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(replay(INIT, SEEDED)).toEqual(replayFrom(created.state, SEEDED));
  });

  it('is deterministic: the same init and commands give identical hashes[i]', () => {
    const a = replay(INIT, SEEDED);
    const b = replay({ ...INIT, config: { ...INIT.config } }, SEEDED);
    expect(b.hashes).toEqual(a.hashes);
    expect(a.hashes).toHaveLength(SEEDED.length);
    expect(replay({ ...INIT, seed: 'other-seed' }, SEEDED).hashes).not.toEqual(a.hashes);
  });

  it('throws on an init that createGame rejects', () => {
    expect(() => replay({ ...INIT, playerCount: 2 as 3 }, SEEDED)).toThrow(/createGame rejected/);
  });
});
