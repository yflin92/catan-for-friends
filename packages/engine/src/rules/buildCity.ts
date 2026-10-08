// 'buildCity' action handler (main only, by the phase table).
import { buildCityAt } from './build';
import type { ActionHandler } from './types';

export const buildCity: ActionHandler<'buildCity'> = (state, seat, action) => buildCityAt(state, seat, action.vertex);
