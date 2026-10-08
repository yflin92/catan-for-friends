// Host seat relink (design §5.1(6), Q8), shared by the lobby roster and the in-game players panel: who may reissue a
// seat's link, the "Reissue link" button (control relinkSeat), and the new link the server sent back to the host
// (snapshot.relinked; memory only). Also the copyable link field both screens use.
import { useState } from 'react';
import type { Seat } from '@hexlands/engine';
import type { RoomView } from '../wire';
import { rejoinLink } from './links';

/** The host may reissue a seated seat's link when seatRelinkEnabled is on; never its own seat. */
export function canRelink(room: RoomView, yourSeat: Seat | null, seat: Seat): boolean {
  const host = yourSeat !== null && yourSeat === room.hostSeat;
  const occupied = room.seats.some((s) => s.seat === seat && s.name !== null);
  return host && room.config.absencePolicy.seatRelinkEnabled && occupied && seat !== yourSeat;
}

export function RelinkButton({ seat, busy, onRelink }: { seat: Seat; busy: boolean; onRelink(seat: Seat): void }) {
  return (
    <button type="button" aria-label={`Reissue link for seat ${seat + 1}`} disabled={busy} onClick={() => onRelink(seat)}>
      Reissue link
    </button>
  );
}

/** The reissued link for `seat`, shown to the host only, when the last relink was for that seat. */
export function RelinkedLink({
  room,
  yourSeat,
  seat,
  relinked,
  origin,
  roomCode,
}: {
  room: RoomView;
  yourSeat: Seat | null;
  seat: Seat;
  relinked: { readonly seat: Seat; readonly seatToken: string } | null;
  origin: string;
  roomCode: string;
}) {
  const host = yourSeat !== null && yourSeat === room.hostSeat;
  if (!host || relinked === null || relinked.seat !== seat) return null;
  return (
    <span className="relinked">
      <CopyField label={`New link for seat ${seat + 1}`} value={rejoinLink(origin, roomCode, relinked.seatToken)} name={`relinked-${seat}`} secret />
      <span className="hint">The old link no longer works. Send this one privately.</span>
    </span>
  );
}

export function CopyField({ label, value, name, secret = false }: { label: string; value: string; name: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div className={secret ? 'copy-field secret' : 'copy-field'}>
      <label>
        {label}
        <input name={name} readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
      </label>
      <button type="button" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
