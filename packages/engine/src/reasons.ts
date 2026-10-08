// The closed rejection-reason enum (design §3.8, requirements P5, ADR-0003). Exactly 44 codes; adding one needs a
// requirements changelog entry and a design revision. HTTP-only codes (HttpReasonCode) live in @hexlands/protocol.
//
// Precedence (exactly one code per rejection):
// - Seat commands: malformed_action → game_over → discard_pending → not_your_turn → wrong_phase → location validity →
//   occupancy → distance → connectivity → pieces → resources/bank → card rules → trade rules.
// - System commands (by: 'system', i.e. skipSeat): malformed_action → game_over → skip_not_allowed.

export type ResultCategory = 'rule' | 'turn' | 'auth' | 'error';
/** The outcome-record result (P1). Closed. */
export type OutcomeResult = 'ok' | ResultCategory;

export const ReasonCode = Object.freeze({
  // turn (3)
  /** Seat not eligible now (AC11); also proposeTrade by a non-active seat. */
  not_your_turn: 'turn',
  /** Action type not allowed in this phase, including a second roll. */
  wrong_phase: 'turn',
  /** Any non-discard action while phase = discard (AC9). */
  discard_pending: 'turn',

  // rule (31)
  insufficient_resources: 'rule',
  no_pieces_left: 'rule',
  /** Off-board ids, or a city not on your own settlement (AC6). */
  invalid_location: 'rule',
  occupied: 'rule',
  distance_rule: 'rule',
  not_connected: 'rule',
  /** The robber's current hex. */
  robber_must_move: 'rule',
  /** Off-board hexes and friendly-robber exclusions (only while the exclusion leaves ≥ 1 legal hex). */
  invalid_robber_hex: 'rule',
  /** Victim with no building on the hex or 0 cards, or victim null while an eligible seat exists. */
  invalid_steal_target: 'rule',
  /** Wrong total, or cards not held. */
  wrong_discard_count: 'rule',
  discard_not_required: 'rule',
  dev_deck_empty: 'rule',
  dev_card_not_owned: 'rule',
  dev_card_bought_this_turn: 'rule',
  dev_card_already_played: 'rule',
  bank_insufficient: 'rule',
  /** Empty side, same resource on both sides, give not in hand, maritime count < 1, X = Y, non-integer value. */
  invalid_trade: 'rule',
  /** The offer id is not the currently open offer (replaced, cancelled, withdrawn, confirmed, or never issued). */
  trade_not_found: 'rule',
  /** At confirm time, either side's holdings no longer cover the exchange. */
  trade_stale: 'rule',
  trade_not_accepted: 'rule',
  room_full: 'rule',
  name_taken: 'rule',
  invalid_name: 'rule',
  game_already_started: 'rule',
  not_enough_players: 'rule',
  capacity_reached: 'rule',
  skip_not_allowed: 'rule',
  /** Any game action once finished. */
  game_over: 'rule',
  /** Any action, hello or link on an expired game (AC29). */
  game_expired: 'rule',
  /** Same actionId with a different payload hash (AC21). */
  action_id_reused: 'rule',
  /** Schema-invalid input, unknown types, invalid lobby config values. */
  malformed_action: 'rule',

  // auth (7) = rejected_auth
  bad_seat_token: 'auth',
  token_room_mismatch: 'auth',
  unknown_room: 'auth',
  seat_superseded: 'auth',
  seat_token_revoked: 'auth',
  not_host: 'auth',
  rate_limited_auth: 'auth',

  // error (3)
  /** Engine exception, persist failure, or any unexpected server fault (NFR3 counts only this). */
  internal_error: 'error',
  /** Retryable with the same actionId (AC27). */
  server_draining: 'error',
  /** Per-connection message rate (P7); retryable after backoff. */
  rate_limited: 'error',
} as const satisfies Record<string, ResultCategory>);

export type ReasonCode = keyof typeof ReasonCode;

export function reasonCategory(r: ReasonCode): ResultCategory {
  return ReasonCode[r];
}

/** The codes reduce() may return. */
export type EngineReasonCode = Extract<
  ReasonCode,
  | 'not_your_turn'
  | 'wrong_phase'
  | 'discard_pending'
  | 'insufficient_resources'
  | 'no_pieces_left'
  | 'invalid_location'
  | 'occupied'
  | 'distance_rule'
  | 'not_connected'
  | 'robber_must_move'
  | 'invalid_robber_hex'
  | 'invalid_steal_target'
  | 'wrong_discard_count'
  | 'discard_not_required'
  | 'dev_deck_empty'
  | 'dev_card_not_owned'
  | 'dev_card_bought_this_turn'
  | 'dev_card_already_played'
  | 'bank_insufficient'
  | 'invalid_trade'
  | 'trade_not_found'
  | 'trade_stale'
  | 'trade_not_accepted'
  | 'skip_not_allowed'
  | 'game_over'
  | 'malformed_action'
  | 'internal_error'
>;
