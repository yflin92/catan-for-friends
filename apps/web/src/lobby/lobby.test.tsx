// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Seat } from '@hexlands/engine';
import type { ControlOp, LobbyOp, OutcomeRecord } from '@hexlands/protocol';
import { App } from '../app';
import { writeCredentials } from '../fragment';
import { Store } from '../store';
import type { RoomView } from '../wire';
import type { CreateRoomResult } from './api';
import { swapOrder } from './Lobby';
import type { LobbyActions } from './lobby-actions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
const ORIGIN = 'https://hex.example';

function lobbyRoom(names: (string | null)[], hostSeat: Seat = 0, seatRelinkEnabled = false): RoomView {
  return {
    lifecycle: 'lobby',
    hostSeat,
    seats: names.map((name, i) => ({ seat: i as Seat, name, connected: name !== null })),
    config: {
      rules: { vpTarget: 10, discardLimit: 7, boardConstraints: { noAdjacentRedNumbers: true }, friendlyRobber: { enabled: false, maxPublicVp: 2 } },
      absencePolicy: { mode: 'pause', skipAfterSec: 120, turnTimerSec: null, skipBy: 'host_or_any_if_host_absent', seatRelinkEnabled },
    },
    waitingOn: [],
    skippable: [],
    buildVersion: 'dev',
  };
}

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
}

let container: HTMLDivElement;
let root: Root;
let store: Store;
let storage: MemoryStorage;
let ops: LobbyOp[];
let controls: ControlOp[];
let nextOutcome: OutcomeRecord;
let actions: LobbyActions & { createRoom: ReturnType<typeof vi.fn>; enterRoom: ReturnType<typeof vi.fn> };

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  store = new Store();
  storage = new MemoryStorage();
  ops = [];
  controls = [];
  nextOutcome = { actionId: 'x', result: 'ok' };
  actions = {
    createRoom: vi.fn<(name: string, pass?: string) => Promise<CreateRoomResult>>(),
    enterRoom: vi.fn((code: string) => store.update({ roomCode: code })),
    lobby: (op) => {
      ops.push(op);
      return Promise.resolve(nextOutcome);
    },
    control: (op) => {
      controls.push(op);
      return Promise.resolve(nextOutcome);
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => root.render(<App store={store} lobby={actions} origin={ORIGIN} storage={storage} />));
}

/** Simulates the server's room message for this tab. */
function room(names: (string | null)[], seat: Seat | null, hostSeat: Seat = 0, seatRelinkEnabled = false) {
  act(() => store.update({ roomCode: 'ABCDEF', room: lobbyRoom(names, hostSeat, seatRelinkEnabled), seat }));
}

function input(name: string): HTMLInputElement {
  const el = container.querySelector(`[name="${name}"]`);
  if (el === null) throw new Error(`no input ${name}`);
  return el as HTMLInputElement;
}

function type(name: string, value: string) {
  const el = input(name);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(text: string | RegExp): HTMLButtonElement {
  const b = [...container.querySelectorAll('button')].find((x) =>
    typeof text === 'string' ? x.textContent === text || x.getAttribute('aria-label') === text : text.test(x.textContent ?? ''),
  );
  if (b === undefined) throw new Error(`no button ${String(text)}`);
  return b;
}

async function click(b: HTMLButtonElement) {
  await act(async () => {
    b.click();
    await Promise.resolve();
  });
}

describe('home screen', () => {
  it('creates a game, stores nothing itself, and shows the invite and private rejoin links in the lobby', async () => {
    actions.createRoom.mockImplementation(async () => {
      writeCredentials(storage, { roomCode: 'ABCDEF', seatToken: TOKEN });
      store.update({ roomCode: 'ABCDEF' });
      return { ok: true, roomCode: 'ABCDEF', seatToken: TOKEN, seat: 0 };
    });
    render();
    type('hostName', ' Ann ');
    await click(button('Create game'));
    expect(actions.createRoom).toHaveBeenCalledWith('Ann', undefined);
    expect(container.textContent).toContain('Connecting to room ABC-DEF');
    room(['Ann', null, null, null], 0);
    expect(input('invite').value).toBe(`${ORIGIN}/#join=ABCDEF`);
    expect(input('rejoin').value).toBe(`${ORIGIN}/#seat=ABCDEF.${TOKEN}`);
    expect(container.textContent).toContain('Keep this private');
  });

  it('shows friendly text for create errors and asks for a passphrase only after bad_passphrase', async () => {
    actions.createRoom.mockResolvedValueOnce({ ok: false, status: 409, reasonCode: 'capacity_reached' });
    render();
    type('hostName', 'Ann');
    await click(button('Create game'));
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/as many games as it can/);
    expect(container.querySelector('[name="passphrase"]')).toBeNull();
    actions.createRoom.mockResolvedValueOnce({ ok: false, status: 403, reasonCode: 'bad_passphrase' });
    await click(button('Create game'));
    expect(container.querySelector('[name="passphrase"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/needs a passphrase/);
    type('passphrase', 'open sesame');
    actions.createRoom.mockResolvedValueOnce({ ok: false, status: 403, reasonCode: 'bad_passphrase' });
    await click(button('Create game'));
    expect(actions.createRoom).toHaveBeenLastCalledWith('Ann', 'open sesame');
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/passphrase isn’t right/);
    actions.createRoom.mockResolvedValueOnce({ ok: false, status: 429, reasonCode: 'rate_limited_auth' });
    await click(button('Create game'));
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Too many attempts/);
    actions.createRoom.mockResolvedValueOnce({ ok: false, status: 429, reasonCode: 'rate_limited' });
    await click(button('Create game'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Too many rooms created from this network recently — try again later.');
    // The passphrase lives only in the form: never in the URL.
    expect(window.location.href).not.toContain('sesame');
  });

  it('relink (Q8): the host reissues another seat\'s link and sees the new link only for that seat', async () => {
    render();
    room(['Ann', 'Bo', 'Cy', null], 0, 0, true);
    expect(() => button('Reissue link for seat 1')).toThrow();
    expect(() => button('Reissue link for seat 4')).toThrow();
    await click(button('Reissue link for seat 2'));
    expect(controls).toEqual([{ kind: 'relinkSeat', seat: 1 }]);
    act(() => store.update({ relinked: { seat: 1, seatToken: TOKEN } }));
    expect(input('relinked-1').value).toBe(`${ORIGIN}/#seat=ABCDEF.${TOKEN}`);
    expect(container.textContent).toContain('The old link no longer works');
    expect(container.querySelector('[name="relinked-2"]')).toBeNull();
  });

  it('relink: hidden when seatRelinkEnabled is false and for non-hosts; a rejection shows its reason', async () => {
    render();
    room(['Ann', 'Bo', 'Cy', null], 0, 0, false);
    expect(() => button('Reissue link for seat 2')).toThrow();
    room(['Ann', 'Bo', 'Cy', null], 1, 0, true);
    expect(() => button('Reissue link for seat 3')).toThrow();
    act(() => store.update({ relinked: { seat: 2, seatToken: TOKEN } }));
    expect(container.querySelector('[name="relinked-2"]')).toBeNull();
    room(['Ann', 'Bo', 'Cy', null], 0, 0, true);
    nextOutcome = { actionId: 'x', result: 'auth', reasonCode: 'not_host' };
    await click(button('Reissue link for seat 3'));
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Only the host/);
  });

  it('joins by code (shown as ABC-DEF) plus name: enters the room, then sends lobby join once', async () => {
    render();
    type('roomCode', 'abc-def');
    type('joinName', 'Bo');
    await click(button('Join'));
    expect(actions.enterRoom).toHaveBeenCalledWith('ABCDEF');
    room(['Ann', null, null, null], null);
    await act(async () => Promise.resolve());
    room(['Ann', null, null, null], null);
    expect(ops).toEqual([{ kind: 'join', displayName: 'Bo' }]);
  });

  it('rejects a malformed code without connecting', async () => {
    render();
    type('roomCode', 'nope!');
    await click(button('Join'));
    expect(actions.enterRoom).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/room code/);
  });
});

describe('lobby', () => {
  it('after an invite link, an unseated visitor picks a name and joins; join errors are friendly', async () => {
    room(['Ann', 'Bo', null, null], null);
    render();
    expect(container.querySelector('[name="rejoin"]')).toBeNull();
    nextOutcome = { actionId: 'x', result: 'rule', reasonCode: 'name_taken' };
    type('displayName', 'bo');
    await click(button('Join'));
    expect(ops).toEqual([{ kind: 'join', displayName: 'bo' }]);
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/already uses that name/);
  });

  it('renders display names as text only (XSS)', () => {
    const evil = '<img src=x onerror=alert(1)>';
    room(['Ann', evil, null, null], 0);
    render();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-roster-seat="1"] .seat-name')?.textContent).toBe(evil);
  });

  it('shows each seat with its colour badge, number label, host/you tags and connection status', () => {
    act(() =>
      store.update({
        roomCode: 'ABCDEF',
        seat: 1,
        room: { ...lobbyRoom(['Ann', 'Bo', 'Cy', null]), seats: [
          { seat: 0, name: 'Ann', connected: true },
          { seat: 1, name: 'Bo', connected: true },
          { seat: 2, name: 'Cy', connected: false },
          { seat: 3, name: null, connected: false },
        ] },
      }),
    );
    render();
    const row = (s: number) => container.querySelector(`[data-roster-seat="${s}"]`)!.textContent;
    expect(row(0)).toMatch(/1Seat 1Annhostonline/);
    expect(row(1)).toMatch(/2Seat 2Boyouonline/);
    expect(row(2)).toMatch(/Cy.*offline/);
    expect(row(3)).toMatch(/Open seat/);
  });

  it('non-hosts see no host controls', () => {
    writeCredentials(storage, { roomCode: 'ABCDEF', seatToken: TOKEN });
    room(['Ann', 'Bo', 'Cy', null], 1);
    render();
    expect(container.querySelector('[aria-label="Remove seat 1"]')).toBeNull();
    expect(() => button('Shuffle seats')).toThrow();
    expect(() => button('Start game')).toThrow();
    expect(input('vpTarget').closest('fieldset')?.disabled).toBe(true);
    expect(container.textContent).toContain('Waiting for the host');
    expect(input('rejoin').value).toBe(`${ORIGIN}/#seat=ABCDEF.${TOKEN}`);
  });

  it('host reorders (full permutation), shuffles and removes seats', async () => {
    room(['Ann', 'Bo', 'Cy', null], 0);
    render();
    await click(button('Move seat 2 up'));
    await click(button('Move seat 3 down'));
    await click(button('Shuffle seats'));
    await click(button('Remove seat 2'));
    expect(ops).toEqual([
      { kind: 'reorderSeats', order: [1, 0, 2, 3] },
      { kind: 'reorderSeats', order: [0, 1, 3, 2] },
      { kind: 'shuffleSeats' },
      { kind: 'removeSeat', seat: 1 },
    ]);
    expect(container.querySelector('[aria-label="Remove seat 1"]')).toBeNull();
  });

  it('Start is enabled only with 3–4 seated; a rejection shows its friendly text', async () => {
    room(['Ann', 'Bo', null, null], 0);
    render();
    expect(button('Start game').disabled).toBe(true);
    expect(container.textContent).toContain('at least 3 players');
    room(['Ann', 'Bo', 'Cy', null], 0);
    expect(button('Start game').disabled).toBe(false);
    nextOutcome = { actionId: 'x', result: 'auth', reasonCode: 'not_host' };
    await click(button('Start game'));
    expect(ops).toEqual([{ kind: 'start' }]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Only the host can do that.');
  });

  it('host applies settings with setConfig; renaming sends rename', async () => {
    room(['Ann', 'Bo', 'Cy', null], 0);
    render();
    expect(button('Apply settings').disabled).toBe(true);
    type('vpTarget', '12');
    await click(button('Apply settings'));
    expect(ops[0]).toMatchObject({ kind: 'setConfig', rules: { vpTarget: 12, discardLimit: 7 }, absencePolicy: { mode: 'pause' } });
    type('rename', 'Annie');
    await click(button('Rename'));
    expect(ops[1]).toEqual({ kind: 'rename', displayName: 'Annie' });
  });

  it('a new room message re-renders the roster (reorder applied by the server)', () => {
    room(['Ann', 'Bo', 'Cy', null], 0);
    render();
    room(['Bo', 'Ann', 'Cy', null], 1);
    expect(container.querySelector('[data-roster-seat="0"] .seat-name')?.textContent).toBe('Bo');
    expect(container.querySelector('[data-roster-seat="1"]')?.textContent).toContain('you');
  });
});

describe('swapOrder', () => {
  it('swaps two positions of the seat permutation', () => {
    expect(swapOrder([0, 1, 2, 3], 1, 2)).toEqual([0, 2, 1, 3]);
    expect(swapOrder([0, 1, 2], 0, 5)).toEqual([0, 1, 2]);
  });
});

