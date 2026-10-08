// POST /api/rooms (design §5.1). The response body carries the host seat token, which the caller stores and never logs.
import type { Seat } from '@hexlands/engine';

export type CreateRoomResult =
  | { readonly ok: true; readonly roomCode: string; readonly seatToken: string; readonly seat: Seat }
  | { readonly ok: false; readonly status: number; readonly reasonCode: string };

export type FetchFn = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export async function createRoomRequest(
  fetchFn: FetchFn,
  body: { readonly displayName: string; readonly passphrase?: string },
): Promise<CreateRoomResult> {
  let res: Pick<Response, 'ok' | 'status' | 'json'>;
  try {
    res = await fetchFn('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    return { ok: false, status: 0, reasonCode: 'internal_error' };
  }
  const json: unknown = await res.json().catch(() => null);
  const obj = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  if (res.ok && typeof obj['roomCode'] === 'string' && typeof obj['seatToken'] === 'string' && typeof obj['seat'] === 'number') {
    return { ok: true, roomCode: obj['roomCode'], seatToken: obj['seatToken'], seat: obj['seat'] as Seat };
  }
  const reasonCode =
    typeof obj['reasonCode'] === 'string' ? obj['reasonCode'] : res.status === 503 ? 'server_draining' : 'internal_error';
  return { ok: false, status: res.status, reasonCode };
}
