// Shared placement validators (R5, R6; design §3.8 precedence: location → occupancy → distance → connectivity →
// pieces). Used by the setup, build and Road Building handlers and by their legal-action slices, so legalActions and
// reduce agree by construction.
import type { EdgeId, Seat, VertexId } from '../ids';
import type { EngineReasonCode } from '../reasons';
import type { GameState } from '../state';
import { STANDARD_TOPOLOGY, isEdgeId, isVertexId } from '../topology';

const T = STANDARD_TOPOLOGY;

/** The owner of the building (settlement or city) on `v`, if any. */
export function buildingAt(state: GameState, v: VertexId): Seat | undefined {
  return state.pieces.settlements[v] ?? state.pieces.cities[v];
}

/**
 * Settlement-site legality: on the board (invalid_location), empty (occupied), and no building one edge away
 * (distance_rule). With `connectedFor`, the vertex must also touch one of that seat's roads (not_connected), as
 * after setup.
 */
export function settlementSiteIssue(
  state: GameState,
  v: VertexId,
  connectedFor?: Seat,
): Extract<EngineReasonCode, 'invalid_location' | 'occupied' | 'distance_rule' | 'not_connected'> | null {
  if (!isVertexId(v)) return 'invalid_location';
  if (buildingAt(state, v) !== undefined) return 'occupied';
  if (T.vertexNeighbours(v).some((n) => buildingAt(state, n) !== undefined)) return 'distance_rule';
  if (connectedFor !== undefined && !T.vertexEdges(v).some((e) => state.pieces.roads[e] === connectedFor)) {
    return 'not_connected';
  }
  return null;
}

/** Whether `seat`'s network reaches vertex `v`: its own building there, or one of its roads at `v` while no opponent
 *  building sits on `v` (a road cannot connect through an opponent's settlement or city). */
function networkReaches(state: GameState, seat: Seat, v: VertexId): boolean {
  const owner = buildingAt(state, v);
  if (owner === seat) return true;
  if (owner !== undefined) return false;
  return T.vertexEdges(v).some((e) => state.pieces.roads[e] === seat);
}

/**
 * Road-site legality: on the board (invalid_location), empty (occupied), and connected (not_connected). With
 * `mustTouch`, the edge must end at that vertex (the setup road beside its settlement); otherwise one end must be
 * reached by the seat's network.
 */
export function roadSiteIssue(
  state: GameState,
  seat: Seat,
  e: EdgeId,
  mustTouch?: VertexId,
): Extract<EngineReasonCode, 'invalid_location' | 'occupied' | 'not_connected'> | null {
  if (!isEdgeId(e)) return 'invalid_location';
  if (state.pieces.roads[e] !== undefined) return 'occupied';
  const ends = T.edgeVertices(e);
  if (mustTouch !== undefined) return ends.includes(mustTouch) ? null : 'not_connected';
  return ends.some((v) => networkReaches(state, seat, v)) ? null : 'not_connected';
}

/** Every vertex where settlementSiteIssue reports nothing, in canonical vertex order. */
export function legalSettlementSites(state: GameState, connectedFor?: Seat): readonly VertexId[] {
  return T.vertices.filter((v) => settlementSiteIssue(state, v, connectedFor) === null);
}

/** Every edge where roadSiteIssue reports nothing, in canonical edge order. */
export function legalRoadSites(state: GameState, seat: Seat, mustTouch?: VertexId): readonly EdgeId[] {
  return T.edges.filter((e) => roadSiteIssue(state, seat, e, mustTouch) === null);
}
