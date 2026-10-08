// 'placeSettlement' action handler. In setupSettlement it runs the setup draft; the main-phase build lands with its
// rule track and is rejected with wrong_phase until then.
import { placeSetupSettlement } from './setup';
import { notImplemented, type ActionHandler } from './types';

export const placeSettlement: ActionHandler<'placeSettlement'> = (state, seat, action) =>
  state.phase.name === 'setupSettlement' ? placeSetupSettlement(state, seat, action.vertex) : notImplemented;
