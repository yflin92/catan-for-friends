// The event log accumulated across views (design D2). Each view carries only a window of recent entries; this store
// keeps every entry seen since load, de-duplicated by `n`. It is separate from the view model, which always stays
// exactly the received view.
import { GAME_EVENT_KINDS, type LogEntryWire } from '@hexlands/protocol';

const KNOWN_KINDS: ReadonlySet<string> = new Set(GAME_EVENT_KINDS);

/** True when this build knows how to describe the event; unknown kinds come from a newer server. */
export function isKnownEventKind(kind: string): boolean {
  return KNOWN_KINDS.has(kind);
}

/** Fallback text for an event of a kind this build does not know. */
export function unknownEventText(kind: string): string {
  return `Unknown event: ${kind}`;
}

type Listener = () => void;

export class LogStore {
  private readonly byN = new Map<number, LogEntryWire>();
  private sorted: readonly LogEntryWire[] = [];
  private readonly listeners = new Set<Listener>();

  /** Merges the entries of a received view; entries already held keep their first-seen copy. */
  merge(entries: readonly LogEntryWire[]): void {
    let added = false;
    for (const e of entries) {
      if (!this.byN.has(e.n)) {
        this.byN.set(e.n, e);
        added = true;
      }
    }
    if (!added) return;
    this.sorted = [...this.byN.values()].sort((a, b) => a.n - b.n);
    for (const l of this.listeners) l();
  }

  clear(): void {
    this.byN.clear();
    this.sorted = [];
    for (const l of this.listeners) l();
  }

  getSnapshot = (): readonly LogEntryWire[] => this.sorted;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
}
