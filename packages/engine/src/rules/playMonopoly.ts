// 'playMonopoly' action handler (R10; AC14). Reached only by the active seat in preRoll or main; see progress.ts.
import { playMonopoly as play } from './progress';
import type { ActionHandler, RuleModule } from './types';

export const playMonopoly: ActionHandler<'playMonopoly'> = (state, seat, action) => play(state, seat, action.resource);

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { handlers: { playMonopoly } };
