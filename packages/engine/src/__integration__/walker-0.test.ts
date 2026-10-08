// E-INT property suite (V2–V5, V11, V39; AC19), shard 0 of SHARDS. 1,000 playouts per PR in total;
// HEXLANDS_WALK_RUNS overrides the total (100,000 nightly, V43).
import { describe, expect, it } from 'vitest';
import { SHARDS, shardRange, walk } from './walker';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const TOTAL = Number.parseInt(env?.['HEXLANDS_WALK_RUNS'] ?? '', 10) || 1000;
const { first, runs } = shardRange(0, TOTAL);

describe(`E-INT walker, shard 0/${SHARDS}`, () => {
  it(`playouts ${first}..${first + runs - 1}: invariants, winner, V39 relation and legal ⇔ reduce probes after every step`, () => {
    const summary = walk(first, runs);
    expect(summary.failures).toEqual([]);
    // Build-first playouts must reach gameOver, or the winner assertion is never exercised.
    expect(summary.gameOvers).toBeGreaterThan(runs / 5);
  }, 900_000);
});
