import { describe, expect, it, vi } from 'vitest';
import { readCredentials, writeCredentials } from '../fragment';
import { createRoomRequest, type FetchFn } from './api';
import { createLobbyActions } from './lobby-actions';

const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
}

const reply = (status: number, body: unknown): FetchFn => () =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

describe('createRoomRequest', () => {
  it('POSTs JSON to /api/rooms without credentials or referrer and returns the body credentials', async () => {
    const fetchFn = vi.fn<FetchFn>(reply(201, { roomCode: 'ABCDEF', seatToken: TOKEN, seat: 0 }));
    await expect(createRoomRequest(fetchFn, { displayName: 'Ann' })).resolves.toEqual({
      ok: true,
      roomCode: 'ABCDEF',
      seatToken: TOKEN,
      seat: 0,
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('/api/rooms');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(String(init.body))).toEqual({ displayName: 'Ann' });
  });

  it.each([
    [409, { reasonCode: 'capacity_reached' }, 'capacity_reached'],
    [403, { reasonCode: 'bad_passphrase' }, 'bad_passphrase'],
    [503, null, 'server_draining'],
    [500, 'oops', 'internal_error'],
  ])('maps HTTP %i to its reason code', async (status, body, code) => {
    await expect(createRoomRequest(reply(status, body), { displayName: 'Ann' })).resolves.toEqual({ ok: false, status, reasonCode: code });
  });

  it('treats a network failure as internal_error', async () => {
    await expect(createRoomRequest(() => Promise.reject(new Error('offline')), { displayName: 'A' })).resolves.toMatchObject({
      ok: false,
      reasonCode: 'internal_error',
    });
  });
});

describe('createLobbyActions', () => {
  it('stores the host token and starts the session after a successful create', async () => {
    const storage = new MemoryStorage();
    const client = { start: vi.fn(), sendLobby: vi.fn(), sendControl: vi.fn() };
    const a = createLobbyActions({ client, storage, fetchFn: reply(201, { roomCode: 'ABCDEF', seatToken: TOKEN, seat: 0 }) });
    await a.createRoom('Ann');
    expect(readCredentials(storage, 'ABCDEF')).toEqual({ roomCode: 'ABCDEF', seatToken: TOKEN });
    expect(client.start).toHaveBeenCalledWith('ABCDEF');
  });

  it('entering a room keeps an existing seat token', () => {
    const storage = new MemoryStorage();
    writeCredentials(storage, { roomCode: 'ABCDEF', seatToken: TOKEN });
    const client = { start: vi.fn(), sendLobby: vi.fn(), sendControl: vi.fn() };
    createLobbyActions({ client, storage, fetchFn: reply(500, null) }).enterRoom('ABCDEF');
    expect(readCredentials(storage, 'ABCDEF')).toEqual({ roomCode: 'ABCDEF', seatToken: TOKEN });
    expect(client.start).toHaveBeenCalledWith('ABCDEF');
  });

  it('control ops go to the client (relinkSeat)', () => {
    const client = { start: vi.fn(), sendLobby: vi.fn(), sendControl: vi.fn() };
    void createLobbyActions({ client, storage: new MemoryStorage(), fetchFn: reply(500, null) }).control({ kind: 'relinkSeat', seat: 2 });
    expect(client.sendControl).toHaveBeenCalledWith({ kind: 'relinkSeat', seat: 2 });
  });
});
