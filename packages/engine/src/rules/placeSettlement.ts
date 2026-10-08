// 'placeSettlement' action handler: the setup draft in setupSettlement, a paid build in main.
import { buildSettlement } from './build';
import { placeSetupSettlement } from './setup';
import type { ActionHandler } from './types';

export const placeSettlement: ActionHandler<'placeSettlement'> = (state, seat, action) =>
  state.phase.name === 'setupSettlement'
    ? placeSetupSettlement(state, seat, action.vertex)
    : buildSettlement(state, seat, action.vertex);
