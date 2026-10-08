// The event log: every entry seen since load (accumulated by n, see log-store.ts), newest at the bottom.
import { useEffect, useRef } from 'react';
import type { Seat } from '@hexlands/engine';
import type { LogEntryWire, RoomView } from '../wire';
import { eventText } from './log-text';
import { seatName } from './names';

export function LogPanel({ entries, you, room }: { entries: readonly LogEntryWire[]; you: Seat; room: RoomView | null }) {
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [entries.length]);
  return (
    <section className="log" aria-label="Game log">
      <h3>Log</h3>
      <ol aria-live="polite">
        {entries.map((e) => (
          <li key={e.n} data-log-n={e.n}>
            {eventText(e, you, (s) => seatName(room, s))}
          </li>
        ))}
        <li ref={end} aria-hidden="true" className="log-end" />
      </ol>
    </section>
  );
}
