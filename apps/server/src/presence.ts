// Seated-player presence (design §9.2, §9.4; NFR5): the disconnect counter and the connected-time counter. The
// player.disconnected / player.reconnected events are emitted by hello.ts (S-5).
// - A disconnect counts only for a socket bound to a seat: catan.ws.disconnects{reason}.
// - catan.player.connected_seconds (the NFR5 denominator) accrues seated-socket time while the game is in lobby or
//   active: on every tick (ACCRUAL_INTERVAL_MS) and at the disconnect, from the later of the seat bind and the last
//   accrual.
import { serverMetrics } from './metrics';
import type { ServerContext } from './server';
import type { TimerHandle } from './clock';
import type { Connection, DisconnectInfo, WsGateway } from './ws-gateway';

/** How often connected time is accrued for open seated sockets. */
export const ACCRUAL_INTERVAL_MS = 60_000;

const COUNTED_LIFECYCLES = ['lobby', 'active'] as const;

export class Presence {
  /** Connection id → clock ms up to which its connected time has been counted. */
  private readonly accruedTo = new Map<number, number>();
  private timer: TimerHandle | null = null;

  constructor(
    private readonly ctx: ServerContext,
    private readonly gateway: () => WsGateway,
  ) {}

  start(): void {
    this.timer ??= this.ctx.clock.setInterval(() => this.accrueAll(), ACCRUAL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) this.ctx.clock.clear(this.timer);
    this.timer = null;
  }

  /**
   * Counts connected time for every open seated socket that is its seat's current holder in a lobby or active game. A
   * socket superseded by another device (P6) keeps its binding until it closes but no longer counts.
   */
  accrueAll(): void {
    const counted = this.countedGames();
    const gateway = this.gateway();
    for (const c of gateway.seatedConnections()) {
      const b = c.binding!;
      if (counted.has(b.gameId) && gateway.connectionOf(b.gameId, b.seat!) === c) this.accrue(c.id, c.seatedSince);
      else this.accruedTo.set(c.id, this.ctx.clock.now());
    }
  }

  /** The gateway's disconnected hook. */
  disconnected(conn: Connection, info: DisconnectInfo): void {
    const b = info.binding;
    if (b === null || b.seat === null) {
      this.accruedTo.delete(conn.id);
      return;
    }
    // The closing socket is already unbound: its seat now has no holder, or a newer socket if this one was superseded.
    const holder = this.gateway().connectionOf(b.gameId, b.seat);
    if ((holder === null || holder === conn) && this.counted(b.gameId)) this.accrue(conn.id, info.seatedSince);
    this.accruedTo.delete(conn.id);
    serverMetrics(this.ctx.telemetry).wsDisconnects.add(1, { reason: info.reason });
  }

  private accrue(connId: number, seatedSince: number | null): void {
    if (seatedSince === null) return;
    const now = this.ctx.clock.now();
    const from = Math.max(seatedSince, this.accruedTo.get(connId) ?? seatedSince);
    if (now > from) serverMetrics(this.ctx.telemetry).playerConnectedSeconds.add((now - from) / 1000);
    this.accruedTo.set(connId, now);
  }

  /** Whether one game is in lobby or active; false once the store is closed (sockets still close during shutdown). */
  private counted(gameId: string): boolean {
    try {
      const lifecycle = this.ctx.store.findGame(gameId)?.lifecycle;
      return lifecycle === 'lobby' || lifecycle === 'active';
    } catch {
      return false;
    }
  }

  /** Games in lobby or active. Empty once the store is closed (sockets still close during shutdown). */
  private countedGames(): ReadonlySet<string> {
    try {
      return new Set(this.ctx.store.listGames(COUNTED_LIFECYCLES).map((g) => g.id));
    } catch {
      return new Set();
    }
  }
}

