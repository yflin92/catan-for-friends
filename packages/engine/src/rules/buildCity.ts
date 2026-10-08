// 'buildCity' action handler (main only, by the phase table).
import { buildCityAt } from './build';
import type { ActionHandler, RuleModule } from './types';

export const buildCity: ActionHandler<'buildCity'> = (state, seat, action) => buildCityAt(state, seat, action.vertex);

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { handlers: { buildCity } };
