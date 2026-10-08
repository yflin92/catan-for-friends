// Legal-actions slice for main-phase builds (design §3.6): exactly the sites the build handlers accept.
import { STANDARD_TOPOLOGY as T } from '../topology';
import { cityIssue, mainRoadIssue, mainSettlementIssue } from './build';
import type { LegalSlice } from './types';

export const buildSlice: LegalSlice = (state, seat) => {
  if (state.phase.name !== 'main' || seat !== state.turn.active) return {};
  return {
    placeRoad: T.edges.filter((e) => mainRoadIssue(state, seat, e) === null),
    placeSettlement: T.vertices.filter((v) => mainSettlementIssue(state, seat, v) === null),
    buildCity: T.vertices.filter((v) => cityIssue(state, seat, v) === null),
  };
};
