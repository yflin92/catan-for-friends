// 'playRoadBuilding' action handler (R10; AC14). Reached only by the active seat in preRoll or main; see progress.ts.
import { playRoadBuilding as play } from './progress';
import type { ActionHandler } from './types';

export const playRoadBuilding: ActionHandler<'playRoadBuilding'> = (state, seat) => play(state, seat);
