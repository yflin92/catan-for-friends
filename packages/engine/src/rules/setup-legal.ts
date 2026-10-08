// Legal-actions slice for the setup draft (design §3.6): exactly the sites the setup handlers accept.
import { legalRoadSites, legalSettlementSites } from './placement';
import type { LegalSlice } from './types';

export const setupSlice: LegalSlice = (state, seat) => {
  if (seat !== state.turn.active) return {};
  if (state.phase.name === 'setupSettlement') return { placeSettlement: legalSettlementSites(state) };
  if (state.phase.name === 'setupRoad') return { placeRoad: legalRoadSites(state, seat, state.phase.from) };
  return {};
};
