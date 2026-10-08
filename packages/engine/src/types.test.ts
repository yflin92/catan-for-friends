// Compile-time checks of the §3 declarations that matter to other tracks (DR2, DR4, the PlayerView brand).
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  RESOURCES,
  RNG_STREAMS,
  TERRAIN_YIELD,
  type GameState,
  type LegalActions,
  type PlayerView,
  type PlayerViewData,
  type PublicProjection,
  type RngStream,
  type Seat,
} from './index';

describe('engine types', () => {
  it('RESOURCES is in canonical order and TERRAIN_YIELD maps every producing terrain', () => {
    expect(RESOURCES).toEqual(['brick', 'lumber', 'wool', 'grain', 'ore']);
    expect(TERRAIN_YIELD).toEqual({ hills: 'brick', forest: 'lumber', pasture: 'wool', fields: 'grain', mountains: 'ore' });
    expect(RNG_STREAMS).toEqual(['board', 'dice', 'devDeck', 'steal', 'absence']);
  });

  it('RNG_STREAMS covers exactly the RngStream union', () => {
    expectTypeOf<(typeof RNG_STREAMS)[number]>().toEqualTypeOf<RngStream>();
    const all: Record<RngStream, true> = { board: true, dice: true, devDeck: true, steal: true, absence: true };
    expect([...RNG_STREAMS].sort()).toEqual(Object.keys(all).sort());
    expect(Object.isFrozen(RNG_STREAMS)).toBe(true);
  });

  it('LegalActions trade fields are exact (DR2)', () => {
    expectTypeOf<LegalActions['respondTrade']>().toEqualTypeOf<{ readonly tradeId: number; readonly canAccept: boolean } | null>();
    expectTypeOf<LegalActions['confirmTrade']>().toEqualTypeOf<{ readonly tradeId: number; readonly partners: readonly Seat[] } | null>();
    expectTypeOf<LegalActions['cancelTrade']>().toEqualTypeOf<number | null>();
    expectTypeOf<LegalActions['proposeTrade']>().toEqualTypeOf<boolean>();
  });

  it('view turn carries the derived endsAfterDiscards flag (DR4), and GameState does not', () => {
    expectTypeOf<PlayerViewData['turn']['endsAfterDiscards']>().toEqualTypeOf<boolean>();
    expectTypeOf<PublicProjection['turn']>().toEqualTypeOf<PlayerViewData['turn']>();
    expectTypeOf<GameState['turn']>().not.toHaveProperty('endsAfterDiscards');
    expectTypeOf<GameState>().not.toHaveProperty('closedTradesThisTurn');
    expectTypeOf<GameState>().toHaveProperty('nextTradeId');
  });

  it('PublicProjection is the view minus the seat-private fields, with log → publicLog (§3.7.1)', () => {
    type Expected = Exclude<keyof PlayerViewData, 'you' | 'hand' | 'devCards' | 'vp' | 'legal' | 'log'> | 'publicLog';
    expectTypeOf<keyof PublicProjection>().toEqualTypeOf<Expected>();
  });

  it('PlayerView cannot be built from plain data', () => {
    const data = {} as PlayerViewData;
    // @ts-expect-error — only view() mints the brand.
    const v: PlayerView = data;
    expect(v).toBe(data);
    expectTypeOf<PlayerView>().toExtend<PlayerViewData>();
  });
});
