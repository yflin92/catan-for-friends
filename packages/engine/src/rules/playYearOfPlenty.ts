// 'playYearOfPlenty' action handler (R10; AC14). Reached only by the active seat in preRoll or main; see progress.ts.
import { playYearOfPlenty as play } from './progress';
import type { ActionHandler, RuleModule } from './types';

export const playYearOfPlenty: ActionHandler<'playYearOfPlenty'> = (state, seat, action) => play(state, seat, action.take);

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { handlers: { playYearOfPlenty } };
