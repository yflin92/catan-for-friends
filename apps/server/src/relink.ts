// Host seat relink (design §5.1(6), ADR-0006, Q8): the host reissues a seat's link mid-game or in the lobby.
import type { Seat } from '@hexlands/engine';
import { hashSeatToken, mintSeatToken } from './codes';
import type { ControlDeps } from './control';
import { requireHost } from './hello';
import type { GameMetaRow } from './store/game-store';
import type { CommandResult, Connection } from './ws-gateway';

/**
 * control relinkSeat, after handleControl's checks (draining, room binding, seated, not expired). Rejections, in order:
 * - not the host → auth/not_host;
 * - absencePolicy.seatRelinkEnabled is false, the host's own seat, or an empty seat → rule/malformed_action.
 * Otherwise, in one transaction, the seat's current token is revoked and a freshly minted one takes its place (the
 * player, name and seat index are unchanged; game state is untouched). The new token goes to the host's socket only as
 * seatToken{purpose:'relinked'}, and the seat's old socket, if connected, is closed 4401: its in-flight commands get
 * auth/seat_token_revoked, as does any later hello with the old token.
 */
export function relinkSeat(deps: ControlDeps, conn: Connection, meta: GameMetaRow, seat: Seat): CommandResult {
  const { ctx } = deps;
  const denied = requireHost(conn, meta);
  if (denied) return denied;
  if (!meta.config.absencePolicy.seatRelinkEnabled || seat === meta.hostSeat) {
    return { result: 'rule', reasonCode: 'malformed_action' };
  }
  const token = mintSeatToken();
  if (!ctx.store.replaceSeatToken(meta.id, seat, hashSeatToken(token), ctx.clock.now())) {
    return { result: 'rule', reasonCode: 'malformed_action' };
  }
  ctx.secrets.record('seatToken', token);
  deps.gateway().revokeSeat(meta.id, seat);
  conn.send({ t: 'seatToken', seat, seatToken: token, purpose: 'relinked' });
  return { result: 'ok' };
}
