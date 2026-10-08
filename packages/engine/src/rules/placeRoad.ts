// 'placeRoad' action handler. In setupRoad it runs the setup draft; main-phase builds and Road Building land with
// their rule tracks and are rejected with wrong_phase until then.
import { placeSetupRoad } from './setup';
import { notImplemented, type ActionHandler } from './types';

export const placeRoad: ActionHandler<'placeRoad'> = (state, seat, action) =>
  state.phase.name === 'setupRoad' ? placeSetupRoad(state, seat, action.edge) : notImplemented;
