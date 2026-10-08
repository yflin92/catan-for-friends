import { turnInternal } from './internal/turn';
export type { GameState } from './state';
export const engine = turnInternal;
