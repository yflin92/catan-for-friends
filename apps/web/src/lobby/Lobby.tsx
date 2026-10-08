// Lobby screen (design §5.1; AC1–AC3): share links, live roster from `room` messages, joining and renaming, host seat
// controls, game settings and Start. Every change goes to the server as a lobby op; the roster only changes when the
// next `room` message arrives. Names are rendered as text only.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AbsencePolicy, GameRules, Seat } from '@hexlands/engine';
import type { ControlOp, LobbyOp, OutcomeRecord } from '@hexlands/protocol';
import { SEAT_STYLE } from '../board/art';
import { readCredentials } from '../fragment';
import { reasonText } from '../reasons';
import type { StoreSnapshot } from '../store';
import type { RoomView } from '../wire';
import type { LobbyActions } from './lobby-actions';
import { formatRoomCode, inviteLink, rejoinLink } from './links';
import { canRelink, CopyField, RelinkButton, RelinkedLink } from './seat-relink';

export interface LobbyProps {
  readonly snapshot: StoreSnapshot & { readonly roomCode: string; readonly room: RoomView };
  readonly actions: LobbyActions;
  readonly origin: string;
  readonly storage: Pick<Storage, 'getItem'>;
  /** A name entered on the home screen: joined with automatically once, while unseated. */
  readonly pendingName: string | null;
  onPendingNameUsed(): void;
}

/** The full permutation for moving the player at index `from` to index `to` (design D9: order[i] = seat moving to i). */
export function swapOrder(seats: readonly Seat[], from: number, to: number): Seat[] {
  const order = [...seats];
  const a = order[from];
  const b = order[to];
  if (a === undefined || b === undefined) return order;
  order[from] = b;
  order[to] = a;
  return order;
}

export function Lobby({ snapshot, actions, origin, storage, pendingName, onPendingNameUsed }: LobbyProps) {
  const { room, roomCode, seat } = snapshot;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isHost = seat !== null && seat === room.hostSeat;
  const seated = room.seats.filter((s) => s.name !== null).length;
  const creds = readCredentials(storage, roomCode);

  const run = async (request: () => Promise<OutcomeRecord>): Promise<OutcomeRecord> => {
    setBusy(true);
    setError(null);
    const o = await request();
    setBusy(false);
    if (o.result !== 'ok') setError(reasonText(o.reasonCode));
    return o;
  };
  const send = (op: LobbyOp) => run(() => actions.lobby(op));
  const control = (op: ControlOp) => run(() => actions.control(op));

  const autoJoined = useRef(false);
  useEffect(() => {
    if (seat === null && pendingName !== null && pendingName !== '' && !autoJoined.current) {
      autoJoined.current = true;
      onPendingNameUsed();
      void send({ kind: 'join', displayName: pendingName });
    }
  });

  const order = room.seats.map((s) => s.seat);

  return (
    <main className="lobby">
      <h2>
        Room <span className="room-code">{formatRoomCode(roomCode)}</span>
      </h2>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="card" aria-labelledby="share">
        <h3 id="share">Invite friends</h3>
        <CopyField label="Invite link" value={inviteLink(origin, roomCode)} name="invite" />
        {creds?.seatToken !== undefined && seat !== null && (
          <>
            <CopyField label="Your rejoin link" value={rejoinLink(origin, roomCode, creds.seatToken)} name="rejoin" secret />
            <p className="hint">Keep this private: anyone with this link can play as you.</p>
          </>
        )}
      </section>

      {seat === null && <JoinForm initialName={pendingName ?? ''} busy={busy} onJoin={(displayName) => void send({ kind: 'join', displayName })} />}

      <section className="card" aria-labelledby="players">
        <h3 id="players">
          Players ({seated}/4)
        </h3>
        <ol className="roster">
          {room.seats.map((s, i) => (
            <li key={s.seat} className="roster-row" data-roster-seat={s.seat}>
              <span className="seat-badge" style={{ background: SEAT_STYLE[s.seat].fill, color: SEAT_STYLE[s.seat].stroke }} aria-hidden="true">
                {SEAT_STYLE[s.seat].label}
              </span>
              <span className="seat-label">Seat {s.seat + 1}</span>
              <span className="seat-name">{s.name ?? 'Open seat'}</span>
              {s.seat === room.hostSeat && <span className="tag">host</span>}
              {s.seat === seat && <span className="tag">you</span>}
              {s.name !== null && <span className={s.connected ? 'status online' : 'status offline'}>{s.connected ? 'online' : 'offline'}</span>}
              {isHost && (
                <span className="row-actions">
                  <button type="button" aria-label={`Move seat ${s.seat + 1} up`} disabled={busy || i === 0} onClick={() => void send({ kind: 'reorderSeats', order: swapOrder(order, i, i - 1) })}>
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move seat ${s.seat + 1} down`}
                    disabled={busy || i === order.length - 1}
                    onClick={() => void send({ kind: 'reorderSeats', order: swapOrder(order, i, i + 1) })}
                  >
                    ↓
                  </button>
                  {s.name !== null && s.seat !== seat && (
                    <button type="button" aria-label={`Remove seat ${s.seat + 1}`} disabled={busy} onClick={() => void send({ kind: 'removeSeat', seat: s.seat })}>
                      Remove
                    </button>
                  )}
                  {canRelink(room, seat, s.seat) && <RelinkButton seat={s.seat} busy={busy} onRelink={(target) => void control({ kind: 'relinkSeat', seat: target })} />}
                </span>
              )}
              <RelinkedLink room={room} yourSeat={seat} seat={s.seat} relinked={snapshot.relinked} origin={origin} roomCode={roomCode} />
            </li>
          ))}
        </ol>
        {seat !== null && <RenameForm busy={busy} onRename={(displayName) => void send({ kind: 'rename', displayName })} />}
        {isHost && (
          <button type="button" disabled={busy} onClick={() => void send({ kind: 'shuffleSeats' })}>
            Shuffle seats
          </button>
        )}
      </section>

      <ConfigSection room={room} editable={isHost} busy={busy} onApply={(rules, absencePolicy) => void send({ kind: 'setConfig', rules, absencePolicy })} />

      {isHost ? (
        <div className="start">
          <button type="button" className="primary" disabled={busy || seated < 3 || seated > 4} onClick={() => void send({ kind: 'start' })}>
            Start game
          </button>
          {seated < 3 && <p className="hint">You need at least 3 players to start.</p>}
        </div>
      ) : (
        <p className="hint">Waiting for the host to start the game.</p>
      )}
    </main>
  );
}

function JoinForm({ initialName, busy, onJoin }: { initialName: string; busy: boolean; onJoin(name: string): void }) {
  const [name, setName] = useState(initialName);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onJoin(name.trim());
  };
  return (
    <section className="card" aria-labelledby="take-seat">
      <h3 id="take-seat">Take a seat</h3>
      <form onSubmit={submit}>
        <label>
          Your name
          <input name="displayName" value={name} maxLength={20} required autoComplete="nickname" onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || name.trim() === ''}>
          Join
        </button>
      </form>
    </section>
  );
}

function RenameForm({ busy, onRename }: { busy: boolean; onRename(name: string): void }) {
  const [name, setName] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onRename(name.trim());
    setName('');
  };
  return (
    <form className="rename" onSubmit={submit}>
      <label>
        Change your name
        <input name="rename" value={name} maxLength={20} autoComplete="nickname" onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" disabled={busy || name.trim() === ''}>
        Rename
      </button>
    </form>
  );
}

function ConfigSection({
  room,
  editable,
  busy,
  onApply,
}: {
  room: RoomView;
  editable: boolean;
  busy: boolean;
  onApply(rules: GameRules, absencePolicy: AbsencePolicy): void;
}) {
  const [rules, setRules] = useState<GameRules>(room.config.rules);
  const [policy, setPolicy] = useState<AbsencePolicy>(room.config.absencePolicy);
  const serverKey = JSON.stringify(room.config);
  // Server config changes (from any host action) replace local edits.
  useEffect(() => {
    const config = JSON.parse(serverKey) as RoomView['config'];
    setRules(config.rules);
    setPolicy(config.absencePolicy);
  }, [serverKey]);

  const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));
  const dirty = JSON.stringify({ rules, absencePolicy: policy }) !== serverKey;

  return (
    <section className="card" aria-labelledby="settings">
      <h3 id="settings">Game settings</h3>
      <form
        className="config"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(rules, policy);
        }}
      >
        <fieldset disabled={!editable || busy}>
          <label>
            Points to win
            <input name="vpTarget" type="number" min={5} max={20} value={rules.vpTarget} onChange={(e) => setRules({ ...rules, vpTarget: num(e.target.value) })} />
          </label>
          <label>
            Discard when holding more than
            <input name="discardLimit" type="number" min={3} max={20} value={rules.discardLimit} onChange={(e) => setRules({ ...rules, discardLimit: num(e.target.value) })} />
          </label>
          <label className="check">
            <input
              name="noAdjacentRedNumbers"
              type="checkbox"
              checked={rules.boardConstraints.noAdjacentRedNumbers}
              onChange={(e) => setRules({ ...rules, boardConstraints: { noAdjacentRedNumbers: e.target.checked } })}
            />
            No 6 and 8 next to each other
          </label>
          <label className="check">
            <input
              name="friendlyRobber"
              type="checkbox"
              checked={rules.friendlyRobber.enabled}
              onChange={(e) => setRules({ ...rules, friendlyRobber: { ...rules.friendlyRobber, enabled: e.target.checked } })}
            />
            Friendly robber
          </label>
          {rules.friendlyRobber.enabled && (
            <label>
              Protects players with at most this many points
              <input
                name="maxPublicVp"
                type="number"
                min={0}
                max={rules.vpTarget - 1}
                value={rules.friendlyRobber.maxPublicVp}
                onChange={(e) => setRules({ ...rules, friendlyRobber: { ...rules.friendlyRobber, maxPublicVp: num(e.target.value) } })}
              />
            </label>
          )}
          <label>
            When a player is away
            <select name="absenceMode" value={policy.mode} onChange={(e) => setPolicy({ ...policy, mode: e.target.value as AbsencePolicy['mode'] })}>
              <option value="pause">Pause the game</option>
              <option value="pause_host_skip">Pause; the host can skip them</option>
              <option value="turn_timer">Turn timer</option>
            </select>
          </label>
          {policy.mode !== 'pause' && (
            <label>
              Skippable after (seconds)
              <input name="skipAfterSec" type="number" min={10} max={3600} value={policy.skipAfterSec} onChange={(e) => setPolicy({ ...policy, skipAfterSec: num(e.target.value) })} />
            </label>
          )}
          {policy.mode === 'turn_timer' && (
            <label>
              Turn timer (seconds)
              <input
                name="turnTimerSec"
                type="number"
                min={30}
                max={3600}
                value={policy.turnTimerSec ?? 120}
                onChange={(e) => setPolicy({ ...policy, turnTimerSec: num(e.target.value) })}
              />
            </label>
          )}
          {editable && (
            <button type="submit" disabled={!dirty}>
              Apply settings
            </button>
          )}
        </fieldset>
      </form>
    </section>
  );
}
