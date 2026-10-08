// Pure helpers for the turn UI. Legality always comes from view.legal; costs and shortfalls are display facts only.
import { RESOURCES, type Resource, type ResourceCounts } from '@hexlands/engine';
import type { LogEntryWire, PlayerViewWire } from '../wire';
import { RESOURCE_NAME } from '../board/art';
import type { PickMode } from '../board/legal-targets';

export type BuildKind = 'road' | 'settlement' | 'city';

/** Printed build costs, shown next to the build buttons. */
export const BUILD_COST: Readonly<Record<BuildKind, Partial<Record<Resource, number>>>> = {
  road: { brick: 1, lumber: 1 },
  settlement: { brick: 1, lumber: 1, wool: 1, grain: 1 },
  city: { grain: 2, ore: 3 },
};

export function formatCounts(counts: Partial<Record<Resource, number>>): string {
  const parts = RESOURCES.filter((r) => (counts[r] ?? 0) > 0).map((r) => `${counts[r]} ${RESOURCE_NAME[r].toLowerCase()}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

/** What the hand is missing for a cost, e.g. "needs 1 brick, 2 ore"; null when the hand covers it. */
export function shortfall(cost: Partial<Record<Resource, number>>, hand: ResourceCounts): string | null {
  const missing: Partial<Record<Resource, number>> = {};
  for (const r of RESOURCES) {
    const need = (cost[r] ?? 0) - hand[r];
    if (need > 0) missing[r] = need;
  }
  return Object.keys(missing).length > 0 ? `needs ${formatCounts(missing)}` : null;
}

/** The board pick the phase itself asks for (setup placements); null when the player chooses. */
export function phasePick(view: PlayerViewWire): PickMode | null {
  const { legal } = view;
  if (legal.phase === 'setupSettlement' && legal.placeSettlement.length > 0) return 'settlement';
  if (legal.phase === 'setupRoad' && legal.placeRoad.length > 0) return 'road';
  return null;
}

/** Which build kinds view.legal currently allows in phase main. */
export function buildable(view: PlayerViewWire): Readonly<Record<BuildKind, boolean>> {
  const main = view.legal.phase === 'main';
  return {
    road: main && view.legal.placeRoad.length > 0,
    settlement: main && view.legal.placeSettlement.length > 0,
    city: main && view.legal.buildCity.length > 0,
  };
}

/** The most recent dice roll in the log, with what this seat received from it. */
export function lastRoll(view: PlayerViewWire): { dice: readonly [number, number]; gains: ResourceCounts | null } | null {
  for (let i = view.log.length - 1; i >= 0; i--) {
    const e: LogEntryWire | undefined = view.log[i];
    if (e !== undefined && e.event.kind === 'diceRolled' && 'dice' in e.event) {
      const ev = e.event as { dice: readonly [number, number]; gains: readonly ResourceCounts[] };
      return { dice: ev.dice, gains: ev.gains[view.you] ?? null };
    }
  }
  return null;
}
