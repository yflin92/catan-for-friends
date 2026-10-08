// A complete wire view (PlayerViewWire) for client tests: the board fixture plus every other view field, valid under
// the protocol's serverMsgSchema. Test-only; never imported by application code.
import type { ResourceCounts } from '@hexlands/engine';
import type { LogEntryWire, PlayerViewWire } from '../wire';
import { boardViewFixture } from './board-fixture';

const rc = (brick: number, lumber: number, wool: number, grain: number, ore: number): ResourceCounts => ({
  brick,
  lumber,
  wool,
  grain,
  ore,
});

export function logEntry(n: number): LogEntryWire {
  return { n, event: { kind: 'devPlayed', seat: 0, card: 'knight' }, visibleTo: 'all' };
}

/** A seat-1 view in phase main; `logNs` picks the log entry numbers it carries. */
export function wireViewFixture(logNs: readonly number[] = [1, 2]): PlayerViewWire {
  const b = boardViewFixture();
  return {
    schemaVersion: 1,
    you: 1,
    config: {
      vpTarget: 10,
      discardLimit: 7,
      boardConstraints: { noAdjacentRedNumbers: true },
      friendlyRobber: { enabled: false, maxPublicVp: 2 },
    },
    playerCount: 3,
    board: b.board,
    robber: b.robber,
    pieces: b.pieces,
    bank: rc(18, 19, 17, 19, 19),
    devDeckCount: 24,
    players: ([0, 1, 2] as const).map((seat) => ({
      seat,
      handCount: 2,
      devCardCount: 0,
      playedDev: { knight: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 },
      publicVp: 2,
      supply: { settlements: 3, cities: 4, roads: 13 },
      longestRoad: 1,
      discardOwed: 0,
    })),
    hand: rc(1, 0, 1, 0, 0),
    devCards: [],
    vp: { public: 2, total: 2 },
    turn: { number: 3, active: 1, dice: [3, 4], devPlayed: false, endsAfterDiscards: false },
    phase: { name: 'main' },
    trade: null,
    awards: { longestRoad: null, largestArmy: null },
    log: logNs.map(logEntry),
    legal: { ...b.legal, seat: 1 },
    reveal: null,
  };
}
