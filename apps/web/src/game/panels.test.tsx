// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Seat } from '@hexlands/engine';
import { GAME_EVENT_KINDS, type OutcomeRecord } from '@hexlands/protocol';
import { App } from '../app';
import { EMPTY_SNAPSHOT, Store } from '../store';
import { wireViewFixture } from '../testing/view-fixture';
import type { LogEntryWire, PlayerViewWire, RoomView } from '../wire';
import { LogPanel } from './LogPanel';
import { eventText } from './log-text';
import { PlayersPanel, WaitingBanner } from './PlayersPanel';
import { WinScreen } from './WinScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rc = (brick = 0, lumber = 0, wool = 0, grain = 0, ore = 0) => ({ brick, lumber, wool, grain, ore });
const room = {
  lifecycle: 'active',
  hostSeat: 0,
  seats: [
    { seat: 0, name: 'Ann', connected: true },
    { seat: 1, name: 'Bo', connected: true },
    { seat: 2, name: 'Cy', connected: false },
  ],
  waitingOn: [],
} as unknown as RoomView;
const name = (s: Seat) => ['Ann', 'Bo', 'Cy', 'Di'][s]!;
const entry = (n: number, event: Record<string, unknown>, visibleTo: 'all' | number[] = 'all') => ({ n, event, visibleTo }) as unknown as LogEntryWire;

const SAMPLES: Record<string, Record<string, unknown>> = {
  diceRolled: { kind: 'diceRolled', seat: 0, dice: [2, 3], gains: [rc(), rc(1), rc()], shortage: [], auto: false },
  setupResources: { kind: 'setupResources', seat: 1, gained: rc(0, 1, 0, 1) },
  built: { kind: 'built', seat: 2, piece: 'city', at: 'v:0,0,N', free: false },
  discarded: { kind: 'discarded', seat: 0, cards: rc(2), auto: false },
  robberMoved: { kind: 'robberMoved', seat: 0, hex: 'h:0,0', victim: 1, auto: false },
  stole: { kind: 'stole', seat: 0, victim: 1 },
  stoleDetail: { kind: 'stoleDetail', seat: 0, victim: 1, resource: 'ore' },
  devBought: { kind: 'devBought', seat: 2 },
  devBoughtDetail: { kind: 'devBoughtDetail', seat: 1, card: 'monopoly' },
  devPlayed: { kind: 'devPlayed', seat: 0, card: 'yearOfPlenty', picks: ['ore', 'wool'] },
  maritimeTraded: { kind: 'maritimeTraded', seat: 1, give: 'brick', gave: 4, receive: 'ore', received: 1 },
  tradeProposed: { kind: 'tradeProposed', offer: { id: 1, from: 0, give: rc(1), get: rc(0, 0, 1), responses: [] }, replaced: null },
  tradeResponded: { kind: 'tradeResponded', tradeId: 1, seat: 2, accept: false },
  tradeResolved: { kind: 'tradeResolved', tradeId: 1, outcome: 'confirmed', partner: 1 },
  awardChanged: { kind: 'awardChanged', award: 'largestArmy', from: null, to: 2 },
  seatSkipped: { kind: 'seatSkipped', seat: 2, reason: 'host' },
  turnEnded: { kind: 'turnEnded', seat: 0, turn: 4, reason: 'endTurn' },
  gameOver: { kind: 'gameOver', winner: 2, vp: [5, 6, 10] },
};

describe('log text', () => {
  it('has a sentence for every GameEvent kind', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...GAME_EVENT_KINDS].sort());
    for (const kind of GAME_EVENT_KINDS) {
      const text = eventText(entry(1, SAMPLES[kind]!), 1, name);
      expect(text, kind).not.toMatch(/Unknown event|undefined|\[object/);
    }
  });

  it('writes from this seat’s point of view', () => {
    expect(eventText(entry(1, SAMPLES['diceRolled']!), 1, name)).toBe('Ann rolled 5 (2 + 3). You got 1 brick.');
    expect(eventText(entry(1, SAMPLES['stole']!), 1, name)).toBe('Ann stole a card from you.');
    expect(eventText(entry(1, SAMPLES['stoleDetail']!, [0, 1]), 1, name)).toBe('The stolen card was 1 ore.');
    expect(eventText(entry(1, SAMPLES['devPlayed']!), 1, name)).toBe('Ann played Year of Plenty (ore + wool).');
    expect(eventText(entry(1, SAMPLES['tradeResolved']!), 1, name)).toBe('The trade went through with you.');
  });

  it('renders an unknown kind from a newer server generically, without crashing', () => {
    const html = renderToStaticMarkup(<LogPanel entries={[entry(9, { kind: 'volcanoErupted', where: 'h:0,0' })]} you={0} room={room} />);
    expect(html).toContain('Unknown event: volcanoErupted');
  });
});

describe('player panels', () => {
  it('shows every public field per seat, award badges, connection, and the own hand and VP total', () => {
    const v = wireViewFixture([]);
    const view: PlayerViewWire = {
      ...v,
      players: v.players.map((p) => (p.seat === 2 ? { ...p, discardOwed: 3, playedDev: { ...p.playedDev, knight: 3 } } : p)),
      awards: { longestRoad: 0, largestArmy: 2 },
      vp: { public: 2, total: 3 },
    };
    const html = renderToStaticMarkup(<PlayersPanel view={view} room={room} />);
    const row = (s: number) => html.split(`data-player-seat="${s}"`)[1]!.split('</li>')[0]!;
    expect(row(0)).toContain('Longest Road');
    expect(row(2)).toContain('Largest Army');
    expect(row(2)).toContain('offline');
    expect(row(2)).toContain('3 knights');
    expect(row(2)).toContain('must discard 3');
    expect(row(1)).toContain('(you)');
    expect(row(1)).toMatch(/2 VP · 2 cards · 0 dev · 0 knights · road 1 · left 13\/3\/4/);
    expect(html).toContain('Your hand: 1 brick, 0 lumber, 1 wool, 0 grain, 0 ore · 3 VP in total');
  });
});

describe('in-game relink (X-relink-FU, AC24 Q8)', () => {
  const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
  const relinkRoom = (seatRelinkEnabled: boolean) =>
    ({ ...room, config: { absencePolicy: { seatRelinkEnabled } } }) as unknown as RoomView;
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const ok = (): Promise<OutcomeRecord> => Promise.resolve({ actionId: 'x', result: 'ok' });
  const show = (yourSeat: Seat, enabled: boolean, relinked: { seat: Seat; seatToken: string } | null, relinkSeat = vi.fn<(seat: Seat) => Promise<OutcomeRecord>>(ok)) => {
    act(() =>
      root.render(
        <PlayersPanel view={wireViewFixture([])} room={relinkRoom(enabled)} relink={{ yourSeat, roomCode: 'ABCDEF', origin: 'https://hex.example', relinked, relinkSeat }} />,
      ),
    );
    return relinkSeat;
  };
  const relinkButton = (seat: number) => container.querySelector<HTMLButtonElement>(`button[aria-label="Reissue link for seat ${seat + 1}"]`);

  it('the host reissues another seat’s link from its panel row and sees the new link for that seat only', async () => {
    const relinkSeat = show(0, true, null);
    expect(relinkButton(0)).toBeNull();
    expect(relinkButton(1)).not.toBeNull();
    await act(async () => relinkButton(2)!.click());
    expect(relinkSeat).toHaveBeenCalledWith(2);
    show(0, true, { seat: 2, seatToken: TOKEN });
    expect(container.querySelector<HTMLInputElement>('[name="relinked-2"]')!.value).toBe(`https://hex.example/#seat=ABCDEF.${TOKEN}`);
    expect(container.textContent).toContain('The old link no longer works');
    expect(container.querySelector('[name="relinked-1"]')).toBeNull();
  });

  it('is absent for non-hosts and when seatRelinkEnabled is off; a rejection shows its reason', async () => {
    show(1, true, { seat: 2, seatToken: TOKEN });
    expect(container.querySelectorAll('button[aria-label^="Reissue link"]')).toHaveLength(0);
    expect(container.querySelector('[name="relinked-2"]')).toBeNull();
    show(0, false, null);
    expect(container.querySelectorAll('button[aria-label^="Reissue link"]')).toHaveLength(0);
    show(0, true, null, vi.fn<(seat: Seat) => Promise<OutcomeRecord>>(() => Promise.resolve({ actionId: 'x', result: 'auth', reasonCode: 'not_host' })));
    await act(async () => relinkButton(1)!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Only the host/);
  });
});

describe('waiting banner (F11)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('shows "Waiting for X (m:ss)" from waitingOn and keeps counting between room updates', () => {
    const r = { ...room, waitingOn: [{ seat: 2, disconnectedForSec: 65 }, { seat: 1, disconnectedForSec: null }] } as unknown as RoomView;
    act(() => root.render(<WaitingBanner room={r} />));
    expect(container.textContent).toBe('Waiting for Cy (1:05)Waiting for Bo');
    act(() => vi.advanceTimersByTime(3000));
    expect(container.textContent).toContain('Waiting for Cy (1:08)');
  });

  it('shows nothing when nobody is waited on', () => {
    act(() => root.render(<WaitingBanner room={room} />));
    expect(container.textContent).toBe('');
  });
});

describe('game over (AC18)', () => {
  it('names the winner and reveals every hand, dev card and VP', () => {
    const v = wireViewFixture([]);
    const view: PlayerViewWire = {
      ...v,
      phase: { name: 'gameOver', winner: 2 },
      reveal: {
        hands: [rc(1), rc(0, 2), rc(0, 0, 0, 0, 3)],
        devCards: [['knight'], [], ['victoryPoint', 'victoryPoint']],
        vp: [6, 4, 10],
      },
    };
    const html = renderToStaticMarkup(<WinScreen view={view} room={room} />);
    expect(html).toContain('Cy won!');
    const row = (s: number) => html.split(`data-reveal-seat="${s}"`)[1]!.split('</tr>')[0]!;
    expect(row(2)).toContain('>10<');
    expect(row(2)).toContain('3 ore');
    expect(row(2)).toContain('Victory Point, Victory Point');
    expect(row(1)).toContain('none');
  });

  it('shows nothing before the game is over', () => {
    expect(renderToStaticMarkup(<WinScreen view={wireViewFixture([])} room={room} />)).toBe('');
  });
});

describe('expired game', () => {
  it('shows "This game has expired" when the room lifecycle is expired', () => {
    const store = new Store({ ...EMPTY_SNAPSHOT, roomCode: 'ABCDEF', room: { ...room, lifecycle: 'expired' } as unknown as RoomView });
    expect(renderToStaticMarkup(<App store={store} />)).toContain('This game has expired.');
  });
});
