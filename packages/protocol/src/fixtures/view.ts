// Hand-built PlayerViewData fixture for protocol tests. Optional fields (devPlayed.picks/taken, tradeResolved.exitTo)
// are deliberately absent in some entries so the round-trip test proves absence survives parsing.
import type { PlayerViewData, ResourceCounts } from '@hexlands/engine';

const rc = (brick: number, lumber: number, wool: number, grain: number, ore: number): ResourceCounts => ({
  brick,
  lumber,
  wool,
  grain,
  ore,
});

export const VIEW_FIXTURE: PlayerViewData = {
  schemaVersion: 1,
  you: 1,
  config: {
    vpTarget: 10,
    discardLimit: 7,
    boardConstraints: { noAdjacentRedNumbers: true },
    friendlyRobber: { enabled: false, maxPublicVp: 2 },
  },
  playerCount: 3,
  board: {
    hexes: [
      { id: 'h:0,-2', terrain: 'mountains', token: 10 },
      { id: 'h:0,0', terrain: 'desert', token: null },
    ],
    harbors: [
      { edge: 'e:0,-2,NW', kind: 'generic' },
      { edge: 'e:1,-2,NE', kind: 'wool' },
    ],
  },
  robber: 'h:0,0',
  pieces: {
    settlements: { 'v:0,-2,N': 0, 'v:1,-1,S': 1 },
    cities: {},
    roads: { 'e:0,-2,NW': 0, 'e:1,-1,W': 1 },
  },
  bank: rc(18, 19, 17, 19, 19),
  devDeckCount: 24,
  players: [0, 1, 2].map((seat) => ({
    seat: seat as 0 | 1 | 2,
    handCount: 2,
    devCardCount: seat === 1 ? 1 : 0,
    playedDev: { knight: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 },
    publicVp: 2,
    supply: { settlements: 3, cities: 4, roads: 13 },
    longestRoad: 1,
    discardOwed: 0,
  })),
  hand: rc(1, 0, 1, 0, 0),
  devCards: [{ kind: 'knight', playableNow: false }],
  vp: { public: 2, total: 2 },
  turn: { number: 3, active: 1, dice: [3, 4], devPlayed: false, endsAfterDiscards: false },
  phase: { name: 'main' },
  trade: {
    id: 4,
    from: 1,
    give: rc(1, 0, 0, 0, 0),
    get: rc(0, 0, 0, 1, 0),
    responses: ['pending', 'self', 'accepted'],
  },
  awards: { longestRoad: null, largestArmy: null },
  log: [
    {
      n: 10,
      event: { kind: 'diceRolled', seat: 1, dice: [3, 4], gains: [rc(0, 0, 0, 0, 0)], shortage: [], auto: false },
      visibleTo: 'all',
    },
    { n: 11, event: { kind: 'devPlayed', seat: 0, card: 'knight' }, visibleTo: 'all' },
    { n: 12, event: { kind: 'devPlayed', seat: 0, card: 'yearOfPlenty', picks: ['ore', 'wool'] }, visibleTo: 'all' },
    { n: 13, event: { kind: 'tradeResolved', tradeId: 3, outcome: 'cancelled', partner: null }, visibleTo: 'all' },
    {
      n: 14,
      event: { kind: 'tradeResolved', tradeId: 2, outcome: 'withdrawn', partner: null, exitTo: 'preRoll' },
      visibleTo: 'all',
    },
    { n: 15, event: { kind: 'stoleDetail', seat: 1, victim: 0, resource: 'brick' }, visibleTo: [0, 1] },
  ],
  legal: {
    seat: 1,
    phase: 'main',
    placeSettlement: [],
    placeRoad: ['e:1,-1,NW'],
    buildCity: [],
    rollDice: false,
    endTurn: true,
    buyDevCard: false,
    playKnight: false,
    playRoadBuilding: false,
    playYearOfPlenty: [],
    playMonopoly: false,
    discard: null,
    moveRobber: [],
    maritime: { brick: 4 },
    bankStock: rc(18, 19, 17, 19, 19),
    proposeTrade: true,
    respondTrade: null,
    confirmTrade: { tradeId: 4, partners: [2] },
    cancelTrade: 4,
  },
  reveal: null,
};
