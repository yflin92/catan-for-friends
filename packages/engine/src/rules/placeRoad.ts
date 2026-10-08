// 'placeRoad' action handler: the setup draft in setupRoad, a paid build in main. Free Road Building roads land with
// their rule track and are rejected with wrong_phase until then.
import { buildRoad } from './build';
import { placeSetupRoad } from './setup';
import { notImplemented, type ActionHandler } from './types';

export const placeRoad: ActionHandler<'placeRoad'> = (state, seat, action) => {
  switch (state.phase.name) {
    case 'setupRoad':
      return placeSetupRoad(state, seat, action.edge);
    case 'main':
      return buildRoad(state, seat, action.edge);
    default:
      return notImplemented;
  }
};
