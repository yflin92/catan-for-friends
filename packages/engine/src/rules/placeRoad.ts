// 'placeRoad' action handler: the setup draft in setupRoad, a paid build in main, a free road in roadBuilding.
import { buildRoad } from './build';
import { placeFreeRoad } from './progress';
import { placeSetupRoad } from './setup';
import { notImplemented, type ActionHandler, type RuleModule } from './types';

export const placeRoad: ActionHandler<'placeRoad'> = (state, seat, action) => {
  switch (state.phase.name) {
    case 'setupRoad':
      return placeSetupRoad(state, seat, action.edge);
    case 'main':
      return buildRoad(state, seat, action.edge);
    case 'roadBuilding':
      return placeFreeRoad(state, seat, action.edge);
    default:
      return notImplemented;
  }
};

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { handlers: { placeRoad } };
