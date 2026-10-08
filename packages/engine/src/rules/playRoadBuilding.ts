// 'playRoadBuilding' action handler (R10; AC14). Reached only by the active seat in preRoll or main; see progress.ts.
import { playRoadBuilding as play } from './progress';
import type { ActionHandler, RuleModule } from './types';

export const playRoadBuilding: ActionHandler<'playRoadBuilding'> = (state, seat) => play(state, seat);

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { handlers: { playRoadBuilding } };
