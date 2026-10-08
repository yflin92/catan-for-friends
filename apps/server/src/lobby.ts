// Lobby operations (design §5.1(3–5), D9; AC2, AC3). Every successful change bumps room_rev and
// last_lobby_activity_at and broadcasts `room` to each member with its own yourSeat.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  ENGINE_VERSION,
  canonicalJson,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  validateGameConfig,
  type GameConfig,
  type GameState,
  type Seat,
} from '@hexlands/engine';
import { CloseCode, type LobbyMsg, type LobbyOp } from '@hexlands/protocol';
import { hashSeatToken, mintSeatToken } from './codes';
import { currentRoomView, requireHost, type HelloDeps } from './hello';
import { normalizeDisplayName } from './names';
import type { GameMetaRow, SeatRow } from './store/game-store';
import type { CommandResult, Connection } from './ws-gateway';

const SEATS: readonly Seat[] = [0, 1, 2, 3];
const IDENTITY: readonly Seat[] = SEATS;
const MIN_PLAYERS = 3;

export function handleLobby(deps: HelloDeps, conn: Connection, msg: LobbyMsg): CommandResult {
  const binding = conn.binding;
  const game = binding ? deps.ctx.store.loadGame(binding.gameId) : null;
  if (!binding || !game) return { result: 'auth', reasonCode: 'unknown_room' };
  const ctx: OpContext = { deps, conn, meta: game.meta, seats: game.seats, seat: binding.seat };
  const op = msg.op;
  switch (op.kind) {
    case 'join':
      return join(ctx, op.displayName);
    case 'rename':
      return rename(ctx, op.displayName);
    case 'reorderSeats':
      return reorder(ctx, op.order);
    case 'shuffleSeats':
      return shuffle(ctx);
    case 'removeSeat':
      return removeSeat(ctx, op.seat);
    case 'setConfig':
      return setConfig(ctx, op);
    case 'start':
      return start(ctx);
  }
}

interface OpContext {
  readonly deps: HelloDeps;
  readonly conn: Connection;
  readonly meta: GameMetaRow;
  readonly seats: readonly SeatRow[];
  /** The requesting socket's seat, or null when it holds none. */
  readonly seat: Seat | null;
}

const OK: CommandResult = { result: 'ok' };
const rule = (reasonCode: 'invalid_name' | 'name_taken' | 'room_full' | 'game_already_started' | 'not_enough_players' | 'malformed_action'): CommandResult => ({
  result: 'rule',
  reasonCode,
});

function nameKey(name: string): string {
  return name.toLowerCase();
}

function join(c: OpContext, raw: string): CommandResult {
  if (c.seat !== null) return rule('malformed_action');
  const name = normalizeDisplayName(raw);
  if (name === null) return rule('invalid_name');
  if (c.seats.some((s) => nameKey(s.displayName) === nameKey(name))) return rule('name_taken');
  const free = SEATS.find((s) => !c.seats.some((r) => r.seat === s));
  if (free === undefined) return rule('room_full');
  if (c.meta.lifecycle !== 'lobby') return rule('game_already_started');
  const { store, secrets, clock } = c.deps.ctx;
  const token = mintSeatToken();
  store.upsertSeat(c.meta.id, free, name, hashSeatToken(token), clock.now());
  secrets.record('seatToken', token);
  c.deps.gateway().bind(c.conn, { gameId: c.meta.id, seat: free });
  c.conn.send({ t: 'seatToken', seat: free, seatToken: token, purpose: 'joined' });
  changed(c);
  return OK;
}

function rename(c: OpContext, raw: string): CommandResult {
  if (c.seat === null) return rule('malformed_action');
  if (c.meta.lifecycle !== 'lobby') return rule('game_already_started');
  const name = normalizeDisplayName(raw);
  if (name === null) return rule('invalid_name');
  if (c.seats.some((s) => s.seat !== c.seat && nameKey(s.displayName) === nameKey(name))) return rule('name_taken');
  c.deps.ctx.store.renameSeat(c.meta.id, c.seat, name);
  changed(c);
  return OK;
}

/** D9 precedence: (schema) → not_host → game_already_started → non-permutation → identity no-op. */
function reorder(c: OpContext, order: readonly Seat[]): CommandResult {
  const denied = requireHost(c.conn, c.meta);
  if (denied) return denied;
  if (c.meta.lifecycle !== 'lobby') return rule('game_already_started');
  if (order.length !== SEATS.length || new Set(order).size !== SEATS.length) return rule('malformed_action');
  if (order.every((s, i) => s === IDENTITY[i])) return OK;
  renumber(c, order);
  changed(c);
  return OK;
}

function shuffle(c: OpContext): CommandResult {
  const denied = requireHost(c.conn, c.meta);
  if (denied) return denied;
  if (c.meta.lifecycle !== 'lobby') return rule('game_already_started');
  const order = [...SEATS];
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j] as Seat, order[i] as Seat];
  }
  if (!order.every((s, i) => s === IDENTITY[i])) renumber(c, order);
  changed(c);
  return OK;
}

function removeSeat(c: OpContext, seat: Seat): CommandResult {
  const denied = requireHost(c.conn, c.meta);
  if (denied) return denied;
  if (c.meta.lifecycle !== 'lobby') return rule('game_already_started');
  if (seat === c.meta.hostSeat) return rule('malformed_action');
  const { store, clock } = c.deps.ctx;
  const hash = store.seatTokenHash(c.meta.id, seat);
  if (hash === null) return rule('malformed_action');
  store.revokeToken(c.meta.id, hash, clock.now());
  c.deps.gateway().connectionOf(c.meta.id, seat)?.close(CloseCode.AUTH_FAILED, 'revoked');
  changed(c);
  return OK;
}

function setConfig(c: OpContext, op: Extract<LobbyOp, { kind: 'setConfig' }>): CommandResult {
  const denied = requireHost(c.conn, c.meta);
  if (denied) return denied;
  if (c.meta.lifecycle !== 'lobby') return rule('game_already_started');
  const next: GameConfig = {
    ...c.meta.config,
    rules: { ...c.meta.config.rules, ...op.rules },
    absencePolicy: { ...c.meta.config.absencePolicy, ...op.absencePolicy },
  };
  const valid = validateGameConfig(next);
  if (!valid.ok) return rule('malformed_action');
  c.deps.ctx.store.updateMeta(c.meta.id, { config: valid.config });
  changed(c);
  return OK;
}

/**
 * Start (§5.1(5), D9 §4). Everything that can fail without side effects runs first (seed, createGame, the checks on a
 * test-injected state). Then ONE store transaction compacts the occupied seats to 0..n−1 in ascending order, writes the
 * seq-0 snapshot and marks the game active, so a failure leaves the lobby exactly as it was. Afterwards every member
 * gets room{yourSeat} with its final index, the GameRoom is adopted, and each seat gets state{seq: 0}.
 */
function start(c: OpContext): CommandResult {
  const denied = requireHost(c.conn, c.meta);
  if (denied) return denied;
  if (c.meta.lifecycle !== 'lobby') return rule('game_already_started');
  const n = c.seats.length;
  if (n < MIN_PLAYERS) return rule('not_enough_players');
  const { ctx } = c.deps;

  const roomCode = c.meta.roomCode ?? '';
  const hooked = ctx.testHooks.seedFor?.(roomCode);
  const seed = hooked?.seed ?? randomBytes(16).toString('hex');
  const created = createGame({
    config: c.meta.config.rules,
    playerCount: n as 3 | 4,
    seed,
    ...(hooked?.streamSeeds !== undefined ? { streamSeeds: hooked.streamSeeds } : {}),
  });
  if (!created.ok) return internalError(c, 'engine', 'createGame refused the frozen config');
  let state: GameState = created.state;
  const injected = ctx.testHooks.initialState?.(roomCode, created.state);
  if (injected !== undefined) {
    if (!injectedStateValid(injected, n, c.meta.config)) {
      return internalError(c, 'engine', 'injected initial state failed its checks');
    }
    state = injected;
  }

  const occupied = SEATS.filter((s) => c.seats.some((r) => r.seat === s));
  const order = occupied.some((s, i) => s !== i) ? [...occupied, ...SEATS.filter((s) => !occupied.includes(s))] : null;
  const now = ctx.clock.now();
  try {
    ctx.store.atomically(() => {
      if (order) ctx.store.renumberSeats(c.meta.id, order);
      ctx.store.writeSnapshot(c.meta.id, 0, serializeState(state), stateHash(state), ENGINE_VERSION, now);
      ctx.store.updateMeta(c.meta.id, {
        lifecycle: 'active',
        seed,
        engineVersion: ENGINE_VERSION,
        startedAt: now,
        lastActionAt: now,
      });
    });
  } catch {
    return internalError(c, 'persist', 'start could not be persisted');
  }
  if (order) c.deps.gateway().renumber(c.meta.id, order);

  ctx.telemetry
    .counter('catan.games.transitions', {
      description: 'lifecycle transitions',
      labels: { from: ['none', 'lobby', 'active', 'abandoned'], to: ['lobby', 'active', 'expired', 'abandoned', 'finished'] },
    })
    .add(1, { from: 'lobby', to: 'active' });
  ctx.telemetry.log('INFO', 'game.started', {
    game_id: c.meta.id,
    player_count: n,
    board_hash: createHash('sha256').update(canonicalJson(state.board)).digest('hex'),
  });
  changed(c);
  c.deps.rooms.adopt(c.meta.id, state, 0).broadcast();
  return OK;
}

/** Server-side checks on a test-injected seq-0 state (design G-A): round-trip, player count and frozen rules. */
function injectedStateValid(s: GameState, playerCount: number, config: GameConfig): boolean {
  const round = deserializeState(serializeState(s));
  return round.ok && s.playerCount === playerCount && canonicalJson(s.config) === canonicalJson(config.rules);
}

function internalError(c: OpContext, component: 'engine' | 'persist', why: string): CommandResult {
  const { telemetry } = c.deps.ctx;
  telemetry
    .counter('catan.errors', {
      description: 'unhandled faults',
      labels: { component: ['ws', 'engine', 'persist', 'http', 'job', 'telemetry'] },
    })
    .add(1, { component });
  telemetry.log('ERROR', 'action.error', { game_id: c.meta.id, error: why });
  return { result: 'error', reasonCode: 'internal_error' };
}

/** Moves seat rows and re-points sockets in memory (D9 §2): order[i] = the old index moving to i. */
function renumber(c: OpContext, order: readonly Seat[]): void {
  c.deps.ctx.store.renumberSeats(c.meta.id, order);
  c.deps.gateway().renumber(c.meta.id, order);
}

/** Bumps room_rev and lobby activity, then sends every member the room with its own yourSeat. */
function changed(c: OpContext): void {
  const { store, clock } = c.deps.ctx;
  const rev = c.meta.roomRev + 1;
  store.updateMeta(c.meta.id, { roomRev: rev, lastLobbyActivityAt: clock.now() });
  broadcastRoom(c.deps, c.meta.id);
}

export function broadcastRoom(deps: HelloDeps, gameId: string): void {
  const game = deps.ctx.store.loadGame(gameId);
  if (!game) return;
  const room = currentRoomView(deps, game.meta);
  for (const member of deps.gateway().connectionsOf(gameId)) {
    member.send({ t: 'room', rev: game.meta.roomRev, room, yourSeat: member.binding?.seat ?? null });
  }
}
