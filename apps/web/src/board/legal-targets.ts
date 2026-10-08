// Which board elements are clickable, derived ONLY from view.legal (ADR-0010: no client-side rules).
import type { EdgeId, HexId, LegalActions, VertexId } from '@hexlands/engine';

/** The board interaction the UI currently asks for. */
export type PickMode = 'settlement' | 'city' | 'road' | 'robber';

export interface BoardTargets {
  readonly vertices: ReadonlySet<VertexId>;
  readonly edges: ReadonlySet<EdgeId>;
  readonly hexes: ReadonlySet<HexId>;
}

const NONE: BoardTargets = { vertices: new Set(), edges: new Set(), hexes: new Set() };

export function legalTargets(legal: LegalActions, mode: PickMode | null): BoardTargets {
  switch (mode) {
    case 'settlement':
      return { ...NONE, vertices: new Set(legal.placeSettlement) };
    case 'city':
      return { ...NONE, vertices: new Set(legal.buildCity) };
    case 'road':
      return { ...NONE, edges: new Set(legal.placeRoad) };
    case 'robber':
      return { ...NONE, hexes: new Set(legal.moveRobber.map((m) => m.hex)) };
    case null:
      return NONE;
  }
}
