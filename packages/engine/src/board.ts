// Board generation (design §3.5, §6 R1/R2, AC4). Every draw comes from the `board` stream, in this exact order (frozen
// for golden fixtures):
//   (1) terrain: one Fisher–Yates over TERRAIN_TILES, assigned to STANDARD_TOPOLOGY.hexes in hex index order;
//   (2) tokens, over the non-desert hexes in hex index order:
//       - noAdjacentRedNumbers on: the {6, 6, 8, 8} hexes are chosen depth-first. At each of the four levels the hexes
//         still available (not chosen, not edge-adjacent to a chosen one) are put in Fisher–Yates order and tried in that
//         order, backtracking on a dead end. The chosen hexes get 6, 6, 8, 8 in pick order. Then one Fisher–Yates over
//         OTHER_TOKENS is assigned to the remaining non-desert hexes in hex index order;
//       - off: one Fisher–Yates over ALL_TOKENS, assigned to the non-desert hexes in hex index order;
//   (3) harbors: one Fisher–Yates over HARBOR_KINDS, assigned to STANDARD_TOPOLOGY.harborSlots in slot order.
// The search always succeeds on the standard board, so generation never retries.
import type { GameRules } from './config';
import type { HexId } from './ids';
import { shuffle, type RngStreamState } from './rng';
import type { Board, HarborKind, Terrain } from './state';
import { STANDARD_TOPOLOGY } from './topology';

/** The 19 terrain tiles before shuffling: hills 3, forest 4, pasture 4, fields 4, mountains 3, desert 1. */
export const TERRAIN_TILES: readonly Terrain[] = Object.freeze([
  ...Array<Terrain>(3).fill('hills'),
  ...Array<Terrain>(4).fill('forest'),
  ...Array<Terrain>(4).fill('pasture'),
  ...Array<Terrain>(4).fill('fields'),
  ...Array<Terrain>(3).fill('mountains'),
  'desert',
]);

/** The 18 number tokens, ascending. */
export const ALL_TOKENS: readonly number[] = Object.freeze([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);
/** The red tokens, in the order they are placed on the chosen hexes. */
export const RED_TOKENS: readonly number[] = Object.freeze([6, 6, 8, 8]);
/** ALL_TOKENS without the reds, ascending. */
export const OTHER_TOKENS: readonly number[] = Object.freeze(ALL_TOKENS.filter((t) => t !== 6 && t !== 8));

/** Harbor kinds before shuffling: 4 generic (3:1), then one 2:1 per resource in canonical resource order. */
export const HARBOR_KINDS: readonly HarborKind[] = Object.freeze([
  'generic', 'generic', 'generic', 'generic', 'brick', 'lumber', 'wool', 'grain', 'ore',
]);

/** Generates a board from the `board` stream and returns it with the advanced stream state. */
export function generateBoard(
  stream: RngStreamState,
  rules: Pick<GameRules, 'boardConstraints'>,
): readonly [Board, RngStreamState] {
  const hexes = STANDARD_TOPOLOGY.hexes;
  const [terrain, st1] = shuffle(stream, TERRAIN_TILES);
  const landed = hexes.filter((_, i) => terrain[i] !== 'desert');

  const token = new Map<HexId, number>();
  let st2: RngStreamState;
  if (rules.boardConstraints.noAdjacentRedNumbers) {
    const [reds, afterReds] = chooseRedHexes(landed, st1);
    reds.forEach((h, i) => token.set(h, RED_TOKENS[i]!));
    const [others, afterOthers] = shuffle(afterReds, OTHER_TOKENS);
    landed.filter((h) => !reds.includes(h)).forEach((h, i) => token.set(h, others[i]!));
    st2 = afterOthers;
  } else {
    const [all, afterAll] = shuffle(st1, ALL_TOKENS);
    landed.forEach((h, i) => token.set(h, all[i]!));
    st2 = afterAll;
  }

  const [kinds, st3] = shuffle(st2, HARBOR_KINDS);
  const board: Board = {
    hexes: hexes.map((id, i) => ({ id, terrain: terrain[i]!, token: token.get(id) ?? null })),
    harbors: STANDARD_TOPOLOGY.harborSlots.map((edge, i) => ({ edge, kind: kinds[i]! })),
  };
  return [board, st3];
}

/** Depth-first choice of RED_TOKENS.length pairwise non-adjacent hexes from `candidates`, in pick order. */
function chooseRedHexes(candidates: readonly HexId[], stream: RngStreamState): readonly [readonly HexId[], RngStreamState] {
  let st = stream;
  const chosen: HexId[] = [];
  const search = (): boolean => {
    if (chosen.length === RED_TOKENS.length) return true;
    const available = candidates.filter(
      (h) => !chosen.includes(h) && !chosen.some((c) => STANDARD_TOPOLOGY.hexNeighbours(c).includes(h)),
    );
    const [order, next] = shuffle(st, available);
    st = next;
    for (const h of order) {
      chosen.push(h);
      if (search()) return true;
      chosen.pop();
    }
    return false;
  };
  if (!search()) throw new Error('generateBoard: no placement for the red tokens');
  return [chosen, st];
}
