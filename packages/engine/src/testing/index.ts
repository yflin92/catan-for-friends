// Test-only builders for @hexlands/engine (subpath @hexlands/engine/testing). Production code must not import this.
export type { BoardIssue } from './board';
export { DEFAULT_TEST_BOARD, validateBoard } from './board';
export { deepFreeze } from './freeze';
export type { InvariantIssue } from './invariants';
export { validateInvariants } from './invariants';
export { forceDice, scriptRng } from './rng';
export { enumerateLegalActions, sampleFromHand, sampleLegalAction } from './sample';
export type { StateSpec } from './state';
export { buildState } from './state';
