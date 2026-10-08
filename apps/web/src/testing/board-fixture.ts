// A wire-shaped board view for component tests, built from STANDARD_TOPOLOGY: a fixed terrain/token layout, the 9
// harbor slots, pieces for three seats and a legal descriptor with targets of every kind. Test-only; never imported
// by application code.
import { STANDARD_TOPOLOGY, type EdgeId, type LegalActions, type Seat, type VertexId } from '@hexlands/engine';
import type { BoardView } from '../board/Board';

type Terrain = BoardView['board']['hexes'][number]['terrain'];
type HarborKind = BoardView['board']['harbors'][number]['kind'];

const TERRAINS: readonly Terrain[] = [
  'mountains', 'pasture', 'forest', 'fields', 'hills', 'pasture', 'hills', 'fields', 'forest', 'desert',
  'forest', 'mountains', 'forest', 'mountains', 'fields', 'pasture', 'hills', 'fields', 'pasture',
];
const TOKENS: readonly number[] = [10, 2, 9, 12, 6, 4, 10, 9, 11, 3, 8, 8, 3, 4, 5, 5, 6, 11];
const HARBORS: readonly HarborKind[] = ['generic', 'wool', 'generic', 'generic', 'brick', 'lumber', 'generic', 'grain', 'ore'];

const T = STANDARD_TOPOLOGY;

function boardFixture(): BoardView['board'] {
  let t = 0;
  return {
    hexes: T.hexes.map((id, i) => {
      const terrain = TERRAINS[i] ?? 'desert';
      return { id, terrain, token: terrain === 'desert' ? null : (TOKENS[t++] ?? null) };
    }),
    harbors: T.harborSlots.map((edge, i) => ({ edge, kind: HARBORS[i] ?? 'generic' })),
  };
}

const EMPTY_COUNTS = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 } as const;

export const LEGAL_NONE: LegalActions = {
  seat: 0,
  phase: 'main',
  placeSettlement: [],
  placeRoad: [],
  buildCity: [],
  rollDice: false,
  endTurn: false,
  buyDevCard: false,
  playKnight: false,
  playRoadBuilding: false,
  playYearOfPlenty: [],
  playMonopoly: false,
  discard: null,
  moveRobber: [],
  maritime: {},
  bankStock: EMPTY_COUNTS,
  proposeTrade: false,
  respondTrade: null,
  confirmTrade: null,
  cancelTrade: null,
};

const desert = T.hexes[TERRAINS.indexOf('desert')] ?? T.hexes[0]!;
const v = T.vertices;
const e = T.edges;

function owned<K extends string>(...entries: (readonly [K, Seat])[]): Record<K, Seat> {
  return Object.fromEntries(entries) as Record<K, Seat>;
}

export function boardViewFixture(): BoardView {
  return {
    board: boardFixture(),
    robber: desert,
    pieces: {
      settlements: owned<VertexId>([v[3]!, 0], [v[20]!, 1], [v[40]!, 2]),
      cities: owned<VertexId>([v[10]!, 0]),
      roads: owned<EdgeId>([e[4]!, 0], [e[30]!, 1], [e[31]!, 1], [e[60]!, 2]),
    },
    legal: {
      ...LEGAL_NONE,
      placeSettlement: [v[0]!, v[7]!, v[25]!, v[50]!],
      buildCity: [v[3]!],
      placeRoad: [e[5]!, e[6]!, e[70]!],
      moveRobber: [
        { hex: T.hexes[0]!, victims: [] },
        { hex: T.hexes[5]!, victims: [1] },
      ],
    },
  };
}
