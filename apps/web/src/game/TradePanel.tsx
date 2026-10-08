// Trading (design §5.4, §3.6 DR2; ADR-0008): maritime trades from legal.maritime, and the single open player offer.
// The proposer builds {give, get}; a new proposal replaces the open offer. Other seats may decline, and accept only
// when legal.respondTrade.canAccept. The proposer confirms with a seat from legal.confirmTrade.partners, or cancels.
// When view.trade becomes null the offer is gone, and the log says why.
import { useState } from 'react';
import { RESOURCES, type Action, type Resource, type ResourceCounts, type Seat } from '@hexlands/engine';
import { RESOURCE_NAME } from '../board/art';
import type { RoomView, PlayerViewWire } from '../wire';
import { seatName } from './names';
import { formatCounts } from './turn-model';

const ZERO: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

export function TradePanel({ view, room, busy, onAction }: { view: PlayerViewWire; room: RoomView | null; busy: boolean; onAction(a: Action): void }) {
  const { legal, trade } = view;
  const closed = trade === null ? lastClosedOffer(view, room) : null;
  return (
    <section className="trade" aria-label="Trade">
      <h3>Trade</h3>
      {trade !== null && <OpenOffer view={view} room={room} busy={busy} onAction={onAction} />}
      {closed !== null && (
        <p className="hint" data-testid="trade-closed">
          {closed}
        </p>
      )}
      {legal.proposeTrade && <OfferComposer hand={view.hand} replacing={trade !== null} busy={busy} onAction={onAction} />}
      {Object.keys(legal.maritime).length > 0 && <Maritime view={view} busy={busy} onAction={onAction} />}
    </section>
  );
}

function OpenOffer({ view, room, busy, onAction }: { view: PlayerViewWire; room: RoomView | null; busy: boolean; onAction(a: Action): void }) {
  const trade = view.trade!;
  const { legal } = view;
  const respond = legal.respondTrade?.tradeId === trade.id ? legal.respondTrade : null;
  const confirm = legal.confirmTrade?.tradeId === trade.id ? legal.confirmTrade : null;
  return (
    <div className="offer" data-trade-id={trade.id}>
      <p>
        <strong>{trade.from === view.you ? 'Your offer' : `${seatName(room, trade.from)} offers`}</strong>: gives {formatCounts(trade.give)}, wants{' '}
        {formatCounts(trade.get)}.
      </p>
      <ul className="responses">
        {trade.responses.map((r, seat) =>
          r === 'self' ? null : (
            <li key={seat} data-response-seat={seat}>
              {seatName(room, seat as Seat)}: {r}
            </li>
          ),
        )}
      </ul>
      {respond !== null && (
        <div className="offer-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !respond.canAccept}
            onClick={() => onAction({ type: 'respondTrade', tradeId: respond.tradeId, accept: true })}
          >
            Accept
          </button>
          <button type="button" disabled={busy} onClick={() => onAction({ type: 'respondTrade', tradeId: respond.tradeId, accept: false })}>
            Decline
          </button>
          {!respond.canAccept && <span className="hint">You don’t have the cards to accept.</span>}
        </div>
      )}
      {confirm !== null && (
        <div className="offer-actions">
          {confirm.partners.map((partner) => (
            <button
              key={partner}
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => onAction({ type: 'confirmTrade', tradeId: confirm.tradeId, partner })}
            >
              Trade with {seatName(room, partner)}
            </button>
          ))}
        </div>
      )}
      {legal.cancelTrade === trade.id && (
        <button type="button" disabled={busy} onClick={() => onAction({ type: 'cancelTrade', tradeId: trade.id })}>
          Cancel offer
        </button>
      )}
    </div>
  );
}

function Counters({ label, counts, max, onChange }: { label: string; counts: ResourceCounts; max: (r: Resource) => number; onChange(c: ResourceCounts): void }) {
  return (
    <fieldset className="counters">
      <legend>{label}</legend>
      {RESOURCES.map((r) => (
        <label key={r}>
          {RESOURCE_NAME[r]}
          <input
            type="number"
            name={`${label}-${r}`}
            min={0}
            max={max(r)}
            value={counts[r]}
            onChange={(e) => onChange({ ...counts, [r]: Math.max(0, Math.min(max(r), Math.floor(Number(e.target.value) || 0))) })}
          />
        </label>
      ))}
    </fieldset>
  );
}

function OfferComposer({ hand, replacing, busy, onAction }: { hand: ResourceCounts; replacing: boolean; busy: boolean; onAction(a: Action): void }) {
  const [give, setGive] = useState<ResourceCounts>(ZERO);
  const [get, setGet] = useState<ResourceCounts>(ZERO);
  const empty = (c: ResourceCounts) => RESOURCES.every((r) => c[r] === 0);
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        onAction({ type: 'proposeTrade', give, get });
      }}
    >
      <Counters label="You give" counts={give} max={(r) => hand[r]} onChange={setGive} />
      <Counters label="You get" counts={get} max={() => 19} onChange={setGet} />
      <button type="submit" disabled={busy || empty(give) || empty(get)}>
        {replacing ? 'Replace offer' : 'Offer to players'}
      </button>
    </form>
  );
}

function Maritime({ view, busy, onAction }: { view: PlayerViewWire; busy: boolean; onAction(a: Action): void }) {
  const gives = RESOURCES.filter((r) => view.legal.maritime[r] !== undefined);
  const [give, setGive] = useState<Resource>(gives[0] ?? 'brick');
  const [receive, setReceive] = useState<Resource>(RESOURCES.find((r) => r !== give) ?? 'lumber');
  const [count, setCount] = useState(1);
  const ratio = view.legal.maritime[give] ?? 4;
  // Display bound only; the server validates the trade.
  const max = Math.max(1, Math.min(Math.floor(view.hand[give] / ratio), view.legal.bankStock[receive]));
  return (
    <form
      className="maritime"
      onSubmit={(e) => {
        e.preventDefault();
        onAction({ type: 'maritimeTrade', give, receive, count });
      }}
    >
      <h4>Bank and harbors</h4>
      <label>
        Give
        <select name="maritimeGive" value={give} onChange={(e) => setGive(e.target.value as Resource)}>
          {gives.map((r) => (
            <option key={r} value={r}>
              {RESOURCE_NAME[r]} ({view.legal.maritime[r]}:1)
            </option>
          ))}
        </select>
      </label>
      <label>
        Get
        <select name="maritimeReceive" value={receive} onChange={(e) => setReceive(e.target.value as Resource)}>
          {RESOURCES.filter((r) => r !== give).map((r) => (
            <option key={r} value={r}>
              {RESOURCE_NAME[r]} (bank has {view.legal.bankStock[r]})
            </option>
          ))}
        </select>
      </label>
      <label>
        How many
        <input name="maritimeCount" type="number" min={1} max={max} value={count} onChange={(e) => setCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
      </label>
      <button type="submit" disabled={busy || give === receive}>
        Trade {count * ratio} {RESOURCE_NAME[give].toLowerCase()} for {count} {RESOURCE_NAME[receive].toLowerCase()}
      </button>
    </form>
  );
}

/** Why the last offer closed, from the newest tradeResolved entry; null when there is nothing to say. */
export function lastClosedOffer(view: PlayerViewWire, room: RoomView | null): string | null {
  for (let i = view.log.length - 1; i >= 0; i--) {
    const ev = view.log[i]?.event as { kind: string; outcome?: string; partner?: Seat | null } | undefined;
    if (ev?.kind === 'tradeProposed') return null;
    if (ev?.kind !== 'tradeResolved') continue;
    switch (ev.outcome) {
      case 'confirmed':
        return ev.partner !== null && ev.partner !== undefined ? `Trade completed with ${seatName(room, ev.partner)}.` : 'Trade completed.';
      case 'cancelled':
        return 'The offer was cancelled.';
      case 'withdrawn':
        return 'The offer was withdrawn when the turn moved on.';
      default:
        return null;
    }
  }
  return null;
}
