// The fixed test board and the R1/R2 board validator (design §3.10; ADR-0001 rev 1.1 harbor slots).
import { DEFAULT_GAME_CONFIG, type GameRules } from '../config';
import type { HexId } from '../ids';
import { RESOURCES, type Board, type HarborKind, type Terrain } from '../state';
import { STANDARD_TOPOLOGY, hexIndex } from '../topology';
import { deepFreeze } from './freeze';

export interface BoardIssue {
  readonly code: string;
  readonly detail: string;
}

/** R1 terrain composition. */
export const TERRAIN_COUNTS: Readonly<Record<Terrain, number>> = Object.freeze({
  hills: 3, forest: 4, pasture: 4, fields: 4, mountains: 3, desert: 1,
});

/** R1 number tokens: one per non-desert hex. */
export const TOKENS: readonly number[] = Object.freeze([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);

/** R2 harbor kinds in canonical order: 4 generic (3:1) and one 2:1 per resource. */
export const HARBOR_KINDS: readonly HarborKind[] = Object.freeze(['generic', 'generic', 'generic', 'generic', ...RESOURCES]);

const RED = new Set([6, 8]);

/**
 * A hand-written, frozen, legal board: exact R1 terrain and tokens, the desert (no token) in the centre at h:0,0, no
 * edge-adjacent pair among {6, 8}, and harbors on STANDARD_TOPOLOGY.harborSlots with 4 generic + one 2:1 per resource.
 * Golden fixtures depend on it, so changing it requires regenerating them in the same change.
 */
export const DEFAULT_TEST_BOARD: Board = deepFreeze({
  hexes: [
    { id: 'h:0,-2', terrain: 'mountains', token: 10 },
    { id: 'h:1,-2', terrain: 'pasture', token: 2 },
    { id: 'h:2,-2', terrain: 'forest', token: 9 },
    { id: 'h:-1,-1', terrain: 'fields', token: 12 },
    { id: 'h:0,-1', terrain: 'hills', token: 6 },
    { id: 'h:1,-1', terrain: 'pasture', token: 4 },
    { id: 'h:2,-1', terrain: 'hills', token: 10 },
    { id: 'h:-2,0', terrain: 'fields', token: 9 },
    { id: 'h:-1,0', terrain: 'forest', token: 11 },
    { id: 'h:0,0', terrain: 'desert', token: null },
    { id: 'h:1,0', terrain: 'forest', token: 3 },
    { id: 'h:2,0', terrain: 'mountains', token: 8 },
    { id: 'h:-2,1', terrain: 'forest', token: 8 },
    { id: 'h:-1,1', terrain: 'mountains', token: 3 },
    { id: 'h:0,1', terrain: 'fields', token: 4 },
    { id: 'h:1,1', terrain: 'pasture', token: 5 },
    { id: 'h:-2,2', terrain: 'hills', token: 5 },
    { id: 'h:-1,2', terrain: 'pasture', token: 6 },
    { id: 'h:0,2', terrain: 'fields', token: 11 },
  ],
  harbors: [
    { edge: 'e:0,-2,NW', kind: 'generic' },
    { edge: 'e:1,-2,NE', kind: 'grain' },
    { edge: 'e:3,-2,W', kind: 'ore' },
    { edge: 'e:3,0,W', kind: 'generic' },
    { edge: 'e:1,2,NW', kind: 'wool' },
    { edge: 'e:-1,3,NE', kind: 'generic' },
    { edge: 'e:-3,3,NE', kind: 'generic' },
    { edge: 'e:-2,1,W', kind: 'brick' },
    { edge: 'e:-2,0,NW', kind: 'lumber' },
  ],
});

function countBy<T>(items: readonly T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/** Issues (one per difference) between an actual and an expected multiset. */
function multisetIssues<T>(code: string, what: string, actual: readonly T[], expected: readonly T[]): BoardIssue[] {
  const a = countBy(actual);
  const e = countBy(expected);
  const keys = [...new Set([...e.keys(), ...a.keys()])];
  return keys
    .filter((k) => (a.get(k) ?? 0) !== (e.get(k) ?? 0))
    .map((k) => ({ code, detail: `${what} ${String(k)}: expected ${e.get(k) ?? 0}, got ${a.get(k) ?? 0}` }));
}

/**
 * Checks a board against R1/R2 and returns every issue found (empty = legal). Issue codes:
 * - `hex_ids`: hexes are not exactly the 19 land hexes in canonical hex index order;
 * - `terrain_count`: terrain composition differs from R1;
 * - `desert_token`: the desert carries a token;
 * - `token_missing`: a non-desert hex has no token;
 * - `token_count`: the token multiset differs from R1;
 * - `adjacent_red_numbers`: two edge-adjacent hexes both carry 6 or 8 (only when noAdjacentRedNumbers is on);
 * - `harbor_slots`: harbor edges are not exactly STANDARD_TOPOLOGY.harborSlots in slot order;
 * - `harbor_kinds`: harbor kinds differ from 4 generic + one per resource.
 * `rules` defaults to DEFAULT_GAME_CONFIG.rules.
 */
export function validateBoard(
  board: Board,
  rules: Pick<GameRules, 'boardConstraints'> = DEFAULT_GAME_CONFIG.rules,
): readonly BoardIssue[] {
  const issues: BoardIssue[] = [];
  const ids = board.hexes.map((h) => h.id);
  if (ids.length !== STANDARD_TOPOLOGY.hexes.length || ids.some((id, i) => id !== STANDARD_TOPOLOGY.hexes[i])) {
    issues.push({ code: 'hex_ids', detail: `expected the 19 land hexes in hex index order, got [${ids.join(', ')}]` });
  }

  issues.push(...multisetIssues('terrain_count', 'terrain', board.hexes.map((h) => h.terrain), terrainList()));
  const tokens: number[] = [];
  for (const h of board.hexes) {
    if (h.terrain === 'desert') {
      if (h.token !== null) issues.push({ code: 'desert_token', detail: `desert ${h.id} has token ${h.token}` });
    } else if (h.token === null) {
      issues.push({ code: 'token_missing', detail: `${h.terrain} ${h.id} has no token` });
    } else {
      tokens.push(h.token);
    }
  }
  issues.push(...multisetIssues('token_count', 'token', tokens, TOKENS));

  if (rules.boardConstraints.noAdjacentRedNumbers) {
    const token = new Map<HexId, number | null>(board.hexes.map((h) => [h.id, h.token]));
    for (const h of STANDARD_TOPOLOGY.hexes) {
      const t = token.get(h);
      if (t == null || !RED.has(t)) continue;
      for (const n of STANDARD_TOPOLOGY.hexNeighbours(h)) {
        const u = token.get(n);
        if (hexIndex(n) > hexIndex(h) && u != null && RED.has(u)) {
          issues.push({ code: 'adjacent_red_numbers', detail: `${h} (${t}) is adjacent to ${n} (${u})` });
        }
      }
    }
  }

  const edges = board.harbors.map((p) => p.edge);
  const slots = STANDARD_TOPOLOGY.harborSlots;
  if (edges.length !== slots.length || edges.some((e, i) => e !== slots[i])) {
    issues.push({ code: 'harbor_slots', detail: `expected harbors on [${slots.join(', ')}] in slot order, got [${edges.join(', ')}]` });
  }
  issues.push(...multisetIssues('harbor_kinds', 'harbor kind', board.harbors.map((p) => p.kind), HARBOR_KINDS));
  return issues;
}

function terrainList(): Terrain[] {
  return (Object.keys(TERRAIN_COUNTS) as Terrain[]).flatMap((t) => Array<Terrain>(TERRAIN_COUNTS[t]).fill(t));
}
