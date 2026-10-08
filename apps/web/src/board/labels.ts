// Human-readable names for board places, derived from the view's board (accessibility: no raw ids in labels).
import { STANDARD_TOPOLOGY, type EdgeId, type HexId, type VertexId } from '@hexlands/engine';
import { RESOURCE_NAME, TERRAIN_NAME, TERRAIN_RESOURCE } from './art';
import { edgeMidpoint, hexToPixel, HEX_SIZE, vertexToPixel, type Point } from './geometry';
import type { PickMode } from './legal-targets';
import type { BoardView } from './Board';

type Hexes = BoardView['board']['hexes'];

const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'] as const;

/** Compass direction from `from` to `to` on screen (y grows south), to the nearest 45°. */
function direction(from: Point, to: Point): string {
  const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  const i = ((Math.round(deg / 45) % 8) + 8) % 8;
  return COMPASS[i] ?? 'east';
}

/** "grain 9", "brick 6", "desert". */
export function hexName(hexes: Hexes, h: HexId): string {
  const hex = hexes.find((x) => x.id === h);
  if (hex === undefined) return 'sea';
  const resource = TERRAIN_RESOURCE[hex.terrain];
  const name = resource !== null ? RESOURCE_NAME[resource].toLowerCase() : TERRAIN_NAME[hex.terrain].toLowerCase();
  return hex.token !== null ? `${name} ${hex.token}` : name;
}

export function hexLabel(hexes: Hexes, h: HexId, robber: HexId): string {
  return `Hex: ${hexName(hexes, h)}${h === robber ? ' (robber)' : ''}`;
}

/** "corner north-east of grain 9, next to ore 10 and wool 4". */
export function vertexLabel(hexes: Hexes, v: VertexId): string {
  const around = STANDARD_TOPOLOGY.vertexHexes(v);
  const [first, ...rest] = around;
  if (first === undefined) return 'corner';
  const dir = direction(hexToPixel(first, HEX_SIZE), vertexToPixel(v, HEX_SIZE));
  const others = rest.map((h) => hexName(hexes, h));
  return `corner ${dir} of ${hexName(hexes, first)}${others.length > 0 ? `, next to ${others.join(' and ')}` : ''}`;
}

/** "side between grain 9 and ore 10", or "coast on the north-east side of grain 9". */
export function edgeLabel(hexes: Hexes, e: EdgeId): string {
  const [a, b] = STANDARD_TOPOLOGY.edgeVertices(e);
  const fromB = new Set(STANDARD_TOPOLOGY.vertexHexes(b));
  const sides = STANDARD_TOPOLOGY.vertexHexes(a).filter((h) => fromB.has(h));
  const [first, second] = sides;
  if (first === undefined) return 'side';
  if (second !== undefined) return `side between ${hexName(hexes, first)} and ${hexName(hexes, second)}`;
  return `coast on the ${direction(hexToPixel(first, HEX_SIZE), edgeMidpoint(e, HEX_SIZE))} side of ${hexName(hexes, first)}`;
}

/** The accessible name of a clickable target in the given pick mode. */
export function targetLabel(mode: PickMode, hexes: Hexes, place: { vertex?: VertexId; edge?: EdgeId; hex?: HexId }, robber: HexId): string {
  switch (mode) {
    case 'settlement':
      return `Build settlement: ${place.vertex !== undefined ? vertexLabel(hexes, place.vertex) : ''}`;
    case 'city':
      return `Upgrade to city: ${place.vertex !== undefined ? vertexLabel(hexes, place.vertex) : ''}`;
    case 'road':
      return `Build road: ${place.edge !== undefined ? edgeLabel(hexes, place.edge) : ''}`;
    case 'robber':
      return `Move robber to ${place.hex !== undefined ? hexLabel(hexes, place.hex, robber).replace(/^Hex: /, '') : ''}`;
  }
}
