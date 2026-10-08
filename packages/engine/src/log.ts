// The game log. Every event is appended through emit(); reduce() returns the events appended while handling a command.
import type { GameEvent, LogEntry } from './events';
import type { Seat } from './ids';
import type { GameState } from './state';

/** state.log keeps the most recent LOG_LIMIT entries; logCounter keeps counting. */
export const LOG_LIMIT = 200;

/** Default visibility: private details are visible to the seats involved; everything else to all (design §3.3). */
export function defaultVisibility(event: GameEvent): 'all' | readonly Seat[] {
  switch (event.kind) {
    case 'stoleDetail':
      return event.seat === event.victim ? [event.seat] : [event.seat, event.victim].sort((a, b) => a - b);
    case 'devBoughtDetail':
      return [event.seat];
    default:
      return 'all';
  }
}

/** Appends one event as the next log entry. */
export function emit(state: GameState, event: GameEvent): GameState {
  const n = state.logCounter + 1;
  const entry: LogEntry = { n, event, visibleTo: defaultVisibility(event) };
  const log = state.log.length >= LOG_LIMIT ? [...state.log.slice(state.log.length - LOG_LIMIT + 1), entry] : [...state.log, entry];
  return { ...state, log, logCounter: n };
}

/** The events appended since `before` (by log counter), in order. */
export function eventsSince(before: GameState, after: GameState): readonly GameEvent[] {
  const added = after.logCounter - before.logCounter;
  if (added <= 0) return [];
  return after.log.slice(-added).map((e) => e.event);
}
