// Player panels (public fields for every seat, own hand and VP), award badges and the waiting banner (F11). The host
// can reissue another seat's link from its panel row (Q8), with the same control and link display as the lobby.
import { useEffect, useState } from 'react';
import { RESOURCES, type Seat } from '@hexlands/engine';
import type { OutcomeRecord } from '@hexlands/protocol';
import { RESOURCE_NAME, SEAT_STYLE } from '../board/art';
import { canRelink, RelinkButton, RelinkedLink } from '../lobby/seat-relink';
import { reasonText } from '../reasons';
import type { PlayerViewWire, RoomView } from '../wire';
import { seatName } from './names';

/** What the panel needs for the host's in-game relink: this tab's seat, the room, the last reissued link, and the op. */
export interface PanelRelink {
  readonly yourSeat: Seat | null;
  readonly roomCode: string;
  readonly origin: string;
  readonly relinked: { readonly seat: Seat; readonly seatToken: string } | null;
  relinkSeat(seat: Seat): Promise<OutcomeRecord>;
}

export function PlayersPanel({ view, room, relink }: { view: PlayerViewWire; room: RoomView | null; relink?: PanelRelink | undefined }) {
  const connected = (seat: Seat) => room?.seats.find((s) => s.seat === seat)?.connected ?? true;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onRelink = async (seat: Seat) => {
    if (relink === undefined) return;
    setBusy(true);
    setError(null);
    const o = await relink.relinkSeat(seat);
    setBusy(false);
    if (o.result !== 'ok') setError(reasonText(o.reasonCode));
  };
  return (
    <section className="players" aria-label="Players">
      <ol>
        {view.players.map((p) => (
          <li key={p.seat} className={p.seat === view.turn.active ? 'player active' : 'player'} data-player-seat={p.seat}>
            <span className="seat-badge" style={{ background: SEAT_STYLE[p.seat].fill, color: SEAT_STYLE[p.seat].stroke }} aria-hidden="true">
              {SEAT_STYLE[p.seat].label}
            </span>
            <span className="player-name">
              {seatName(room, p.seat)}
              {p.seat === view.you && ' (you)'}
            </span>
            {!connected(p.seat) && <span className="tag">offline</span>}
            {view.awards.longestRoad === p.seat && <span className="award">Longest Road</span>}
            {view.awards.largestArmy === p.seat && <span className="award">Largest Army</span>}
            <span className="stats">
              {p.publicVp} VP · {p.handCount} cards · {p.devCardCount} dev · {p.playedDev.knight} knights · road {p.longestRoad} · left{' '}
              {p.supply.roads}/{p.supply.settlements}/{p.supply.cities}
              {p.discardOwed > 0 && ` · must discard ${p.discardOwed}`}
            </span>
            {relink !== undefined && room !== null && canRelink(room, relink.yourSeat, p.seat) && (
              <RelinkButton seat={p.seat} busy={busy} onRelink={(seat) => void onRelink(seat)} />
            )}
            {relink !== undefined && room !== null && (
              <RelinkedLink room={room} yourSeat={relink.yourSeat} seat={p.seat} relinked={relink.relinked} origin={relink.origin} roomCode={relink.roomCode} />
            )}
          </li>
        ))}
      </ol>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="my-hand" data-testid="my-hand">
        Your hand: {RESOURCES.map((r) => `${view.hand[r]} ${RESOURCE_NAME[r].toLowerCase()}`).join(', ')} · {view.vp.total} VP in total
      </p>
    </section>
  );
}

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Waiting for X (m:ss)" for each seat in room.waitingOn, shown whatever the absence policy (AC28). */
export function WaitingBanner({ room }: { room: RoomView }) {
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setSince(Date.now());
  }, [room]);
  useEffect(() => {
    if (room.waitingOn.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [room.waitingOn.length]);
  if (room.waitingOn.length === 0) return null;
  const extra = Math.max(0, (now - since) / 1000);
  return (
    <div className="notice" role="status" data-notice="waiting">
      {room.waitingOn.map((w) => (
        <p key={w.seat}>
          Waiting for {seatName(room, w.seat)}
          {w.disconnectedForSec !== null && ` (${mmss(w.disconnectedForSec + extra)})`}
        </p>
      ))}
    </div>
  );
}
