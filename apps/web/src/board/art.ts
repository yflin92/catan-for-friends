// Original Hexlands art tokens (requirements C1, F3): palette, generic names and per-seat markings. Everything here is
// drawn in code; there are no third-party assets (see apps/web/ASSETS.md).
import type { HarborKind, Seat } from '@hexlands/engine';

export type Terrain = 'hills' | 'forest' | 'pasture' | 'fields' | 'mountains' | 'desert';
export type Resource = Exclude<HarborKind, 'generic'>;

export const TERRAIN_FILL: Readonly<Record<Terrain, string>> = {
  hills: '#c8754a',
  forest: '#3f7d4e',
  pasture: '#9ccf6a',
  fields: '#e9c25a',
  mountains: '#8d8f99',
  desert: '#e3d3a8',
};

export const TERRAIN_NAME: Readonly<Record<Terrain, string>> = {
  hills: 'Hills',
  forest: 'Forest',
  pasture: 'Pasture',
  fields: 'Fields',
  mountains: 'Mountains',
  desert: 'Desert',
};

export const TERRAIN_RESOURCE: Readonly<Record<Terrain, Resource | null>> = {
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
  desert: null,
};

export const RESOURCE_NAME: Readonly<Record<Resource, string>> = {
  brick: 'Brick',
  lumber: 'Lumber',
  wool: 'Wool',
  grain: 'Grain',
  ore: 'Ore',
};

/** Fixed seat markings: a colour plus a number label and a road dash pattern, so seats never differ by colour alone. */
export interface SeatStyle {
  readonly fill: string;
  readonly stroke: string;
  /** Shown on settlements and cities; seats are numbered from 1 in the UI. */
  readonly label: string;
  /** SVG stroke-dasharray for roads, in units of the hex size; empty = solid. */
  readonly roadDash: readonly number[];
}

export const SEAT_STYLE: Readonly<Record<Seat, SeatStyle>> = {
  0: { fill: '#d64545', stroke: '#6e1a1a', label: '1', roadDash: [] },
  1: { fill: '#2f6fde', stroke: '#14336b', label: '2', roadDash: [0.22, 0.08] },
  2: { fill: '#f0f0f0', stroke: '#3a3a3a', label: '3', roadDash: [0.08, 0.06] },
  3: { fill: '#e8913d', stroke: '#6b3d10', label: '4', roadDash: [0.22, 0.06, 0.04, 0.06] },
};

export function harborRatioLabel(kind: HarborKind): string {
  return kind === 'generic' ? '3:1' : '2:1';
}

export function harborName(kind: HarborKind): string {
  return kind === 'generic' ? 'Any' : RESOURCE_NAME[kind];
}
