import { describe, expect, it } from 'vitest';
import { ALL_TOKENS, HARBOR_KINDS, TERRAIN_TILES, generateBoard } from './board';
import { DEFAULT_GAME_CONFIG, type GameRules } from './config';
import { seedStream } from './rng';
import { validateBoard } from './testing';
import { STANDARD_TOPOLOGY } from './topology';

const ON = DEFAULT_GAME_CONFIG.rules;
const OFF = { boardConstraints: { noAdjacentRedNumbers: false } };
const gen = (seed: string, rules: Pick<GameRules, 'boardConstraints'> = ON) => generateBoard(seedStream(seed, 'board'), rules);
const SEEDS = Array.from({ length: 10_000 }, (_, i) => `seed-${i}`);

// Each 10 000-seed sweep is CPU-bound and takes seconds on a shared CI runner, so the default 5 s timeout is too tight.
describe('generateBoard (design §3.5, §6 R1/R2, AC4)', { timeout: 30_000 }, () => {
  it('every generated board passes validateBoard, with the red-number constraint on', () => {
    for (const seed of SEEDS) expect(validateBoard(gen(seed)[0]), seed).toEqual([]);
  });

  it('every generated board passes validateBoard with the constraint off (composition, tokens, harbors)', () => {
    for (const seed of SEEDS) expect(validateBoard(gen(seed, OFF)[0], OFF), seed).toEqual([]);
  });

  it('never puts 6–6, 8–8 or 6–8 on edge-adjacent hexes when the constraint is on', () => {
    for (const seed of SEEDS) {
      const token = new Map(gen(seed)[0].hexes.map((h) => [h.id, h.token]));
      for (const h of STANDARD_TOPOLOGY.hexes) {
        if (token.get(h) !== 6 && token.get(h) !== 8) continue;
        for (const n of STANDARD_TOPOLOGY.hexNeighbours(h)) expect([6, 8], `${seed}: ${h}–${n}`).not.toContain(token.get(n));
      }
    }
  });

  it('with the constraint off, adjacent reds do occur (a plain shuffle)', () => {
    const adjacentReds = SEEDS.some((seed) => {
      const token = new Map(gen(seed, OFF)[0].hexes.map((h) => [h.id, h.token]));
      return STANDARD_TOPOLOGY.hexes.some(
        (h) => [6, 8].includes(token.get(h)!) && STANDARD_TOPOLOGY.hexNeighbours(h).some((n) => [6, 8].includes(token.get(n)!)),
      );
    });
    expect(adjacentReds).toBe(true);
  });

  it('is a pure function of the board stream state: the same seed gives an identical board and stream', () => {
    expect(gen('same')).toEqual(gen('same'));
    expect(gen('same')[0]).not.toEqual(gen('other')[0]);
  });

  it('starts from the canonical tile, token and harbor lists', () => {
    expect(TERRAIN_TILES.join(',')).toBe(
      'hills,hills,hills,forest,forest,forest,forest,pasture,pasture,pasture,pasture,fields,fields,fields,fields,mountains,mountains,mountains,desert',
    );
    expect(ALL_TOKENS).toEqual([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);
    expect(HARBOR_KINDS).toEqual(['generic', 'generic', 'generic', 'generic', 'brick', 'lumber', 'wool', 'grain', 'ore']);
  });
});
