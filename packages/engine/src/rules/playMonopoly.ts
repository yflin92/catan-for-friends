// 'playMonopoly' action handler (R10; AC14). Reached only by the active seat in preRoll or main; see progress.ts.
import { playMonopoly as play } from './progress';
import type { ActionHandler } from './types';

export const playMonopoly: ActionHandler<'playMonopoly'> = (state, seat, action) => play(state, seat, action.resource);
