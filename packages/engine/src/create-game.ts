// createGame (design §3.4, §3.5): validates the init, seeds the five RNG streams, generates the board from the board
// stream and shuffles the dev deck from the devDeck stream. Nothing else draws at creation.
import type { GameInit } from './api';
import { generateBoard } from './board';
import { DEFAULT_GAME_CONFIG, validateGameConfig } from './config';
import { RNG_STREAMS, initRng, shuffle } from './rng';
import type { DevCardKind, GameState, PlayerState } from './state';

/** The 25 development cards before shuffling: 14 knight, 5 victory point, 2 each of road building, year of plenty and
 *  monopoly. The deck draws from its end. */
export const DEV_DECK: readonly DevCardKind[] = Object.freeze([
  ...Array<DevCardKind>(14).fill('knight'),
  ...Array<DevCardKind>(5).fill('victoryPoint'),
  ...Array<DevCardKind>(2).fill('roadBuilding'),
  ...Array<DevCardKind>(2).fill('yearOfPlenty'),
  ...Array<DevCardKind>(2).fill('monopoly'),
]);

const INIT_KEYS = ['config', 'playerCount', 'seed', 'streamSeeds'];

/** A well-formed init: known keys only, playerCount 3 or 4, a non-empty seed, rules that validateGameConfig accepts,
 *  and streamSeeds (if present) mapping RNG stream names to non-empty strings. */
function isValidInit(init: unknown): init is GameInit {
  if (typeof init !== 'object' || init === null || Array.isArray(init)) return false;
  const o = init as Record<string, unknown>;
  if (Object.keys(o).some((k) => !INIT_KEYS.includes(k))) return false;
  if (o['playerCount'] !== 3 && o['playerCount'] !== 4) return false;
  if (typeof o['seed'] !== 'string' || o['seed'].length === 0) return false;
  if (!validateGameConfig({ ...DEFAULT_GAME_CONFIG, rules: o['config'] }).ok) return false;
  const seeds = o['streamSeeds'];
  if (seeds === undefined) return true;
  if (typeof seeds !== 'object' || seeds === null || Array.isArray(seeds)) return false;
  return Object.entries(seeds).every(
    ([k, v]) => (RNG_STREAMS as readonly string[]).includes(k) && typeof v === 'string' && v.length > 0,
  );
}

/** The initial state: setupSettlement round 1 for seat 0, bank 19 each, supply 5/4/15, robber on the desert. A
 *  malformed init → malformed_action. Never throws and never retries. */
export function createGame(init: GameInit): { ok: true; state: GameState } | { ok: false; reason: 'malformed_action' } {
  if (!isValidInit(init)) return { ok: false, reason: 'malformed_action' };
  const config = JSON.parse(JSON.stringify(init.config)) as GameState['config'];
  const seeded = initRng(init.seed, init.streamSeeds);
  const [board, boardStream] = generateBoard(seeded.board, config);
  const [devDeck, deckStream] = shuffle(seeded.devDeck, DEV_DECK);
  const desert = board.hexes.find((h) => h.terrain === 'desert')!;

  const player = (): PlayerState => ({
    hand: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 },
    devCards: [],
    playedDev: { knight: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 },
    supply: { settlements: 5, cities: 4, roads: 15 },
    longestRoad: 0,
  });

  const state: GameState = {
    schemaVersion: 1,
    config,
    playerCount: init.playerCount,
    board,
    robber: desert.id,
    pieces: { settlements: {}, cities: {}, roads: {} },
    players: Array.from({ length: init.playerCount }, player),
    bank: { brick: 19, lumber: 19, wool: 19, grain: 19, ore: 19 },
    devDeck: [...devDeck],
    turn: { number: 0, active: 0, dice: null, devPlayed: false },
    phase: { name: 'setupSettlement', round: 1 },
    trade: null,
    nextTradeId: 1,
    awards: { longestRoad: null, largestArmy: null },
    rng: { ...seeded, board: boardStream, devDeck: deckStream },
    log: [],
    logCounter: 0,
  };
  return { ok: true, state };
}
