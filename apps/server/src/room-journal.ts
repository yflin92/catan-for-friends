// Per-game observation of committed commands (design §9.2, §9.5): the turn.ended and trade.* events derived from the
// engine's GameEvents, and the commit time of recent seqs for catan.ws.delivery.duration (commit of seq N → ack N).
// All times come from the injectable clock.
import type { GameEvent } from '@hexlands/engine';
import type { Clock } from './clock';
import { logEvent } from './log-events';
import { serverMetrics } from './metrics';
import type { Telemetry } from './telemetry';

/** Commit times kept for delivery measurement; an ack for an older seq is not measured. */
export const DELIVERY_WINDOW = 256;

const RESOURCE_KEYS = ['brick', 'lumber', 'wool', 'grain', 'ore'] as const;
const cardCount = (c: Readonly<Record<(typeof RESOURCE_KEYS)[number], number>>): number => RESOURCE_KEYS.reduce((n, r) => n + c[r], 0);

export class RoomJournal {
  private turnStartedAt: number;
  private turnActions = 0;
  private turnDice: number | null = null;
  private readonly offersOpenedAt = new Map<number, number>();
  private readonly commitAt = new Map<number, number>();

  constructor(
    private readonly gameId: string,
    private readonly clock: Clock,
    private readonly telemetry: Telemetry,
  ) {
    this.turnStartedAt = clock.now();
  }

  /** Records one committed command at `seq` and emits the events it implies. */
  committed(seq: number, events: readonly GameEvent[]): void {
    const now = this.clock.now();
    this.commitAt.set(seq, now);
    this.commitAt.delete(seq - DELIVERY_WINDOW);
    this.turnActions += 1;
    const skipped = events.find((e) => e.kind === 'seatSkipped');
    for (const e of events) {
      switch (e.kind) {
        case 'diceRolled':
          this.turnDice = e.dice[0] + e.dice[1];
          break;
        case 'tradeProposed':
          this.offersOpenedAt.set(e.offer.id, now);
          logEvent(this.telemetry, 'trade.proposed', {
            game_id: this.gameId,
            trade_id: e.offer.id,
            from_seat: e.offer.from,
            give_count: cardCount(e.offer.give),
            get_count: cardCount(e.offer.get),
          });
          break;
        case 'tradeResolved': {
          const opened = this.offersOpenedAt.get(e.tradeId);
          this.offersOpenedAt.delete(e.tradeId);
          logEvent(this.telemetry, 'trade.resolved', {
            game_id: this.gameId,
            trade_id: e.tradeId,
            outcome: e.outcome,
            exit_to: e.exitTo,
            partner_seat: e.partner,
            open_s: opened === undefined ? null : (now - opened) / 1000,
          });
          break;
        }
        case 'turnEnded':
          logEvent(this.telemetry, 'turn.ended', {
            game_id: this.gameId,
            turn: e.turn,
            seat: e.seat,
            duration_s: (now - this.turnStartedAt) / 1000,
            actions: this.turnActions,
            dice_total: this.turnDice,
            reason: e.reason === 'endTurn' ? 'end_turn' : skipped?.kind === 'seatSkipped' && skipped.reason === 'timer' ? 'timer' : 'host_skip',
          });
          this.turnStartedAt = now;
          this.turnActions = 0;
          this.turnDice = null;
          break;
        default:
          break;
      }
    }
  }

  /** catan.ws.delivery.duration for one recipient's first ack of `seq`, when its commit time is still known. */
  acked(seq: number): void {
    const at = this.commitAt.get(seq);
    if (at === undefined) return;
    serverMetrics(this.telemetry).wsDelivery.record((this.clock.now() - at) / 1000);
  }
}
