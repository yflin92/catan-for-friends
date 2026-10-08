// Friendly text for server reason codes (design §3.8) and the HTTP-only create codes. Unknown codes fall back to a
// generic message, so a newer server never produces a blank error.
const TEXT: Readonly<Record<string, string>> = {
  // lobby and rooms
  room_full: 'This room is full (4 players).',
  name_taken: 'Someone in this room already uses that name. Pick another.',
  invalid_name: 'Names must be 1–20 characters, without control characters.',
  game_already_started: 'This game has already started, so new players can’t join.',
  not_enough_players: 'You need at least 3 players to start.',
  capacity_reached: 'The server is hosting as many games as it can right now. Try again later.',
  bad_passphrase: 'That passphrase isn’t right.',
  not_host: 'Only the host can do that.',
  // auth
  unknown_room: 'No room with that code. Check the code and try again.',
  rate_limited_auth: 'Too many attempts. Wait a minute and try again.',
  bad_seat_token: 'This seat link isn’t valid.',
  token_room_mismatch: 'This seat link belongs to a different room.',
  seat_token_revoked: 'This seat link is no longer valid.',
  seat_superseded: 'This seat was opened on another device.',
  // lifecycle and transport
  game_expired: 'This game has expired.',
  game_over: 'The game is over.',
  server_draining: 'The server is restarting. Your move will be retried.',
  rate_limited: 'You’re sending too fast. Slow down a moment.',
  internal_error: 'Something went wrong on the server. Try again.',
  malformed_action: 'The server didn’t accept that request.',
  action_id_reused: 'That request conflicts with an earlier one.',
  // turn
  not_your_turn: 'It isn’t your turn.',
  wrong_phase: 'You can’t do that right now.',
  discard_pending: 'Waiting for discards first.',
  // rules
  insufficient_resources: 'You don’t have enough resources.',
  no_pieces_left: 'You have no pieces of that kind left.',
  invalid_location: 'You can’t build there.',
  occupied: 'That spot is taken.',
  distance_rule: 'Too close to another settlement.',
  not_connected: 'That spot isn’t connected to your roads.',
  robber_must_move: 'The robber has to move to a different hex.',
  invalid_robber_hex: 'The robber can’t go there.',
  invalid_steal_target: 'You can’t steal from that player.',
  wrong_discard_count: 'Discard exactly the number of cards shown.',
  discard_not_required: 'You don’t need to discard.',
  dev_deck_empty: 'No development cards are left.',
  dev_card_not_owned: 'You don’t have that card.',
  dev_card_bought_this_turn: 'You can’t play a card on the turn you bought it.',
  dev_card_already_played: 'You’ve already played a development card this turn.',
  bank_insufficient: 'The bank doesn’t have enough of that resource.',
  invalid_trade: 'That trade isn’t valid.',
  trade_not_found: 'That offer is no longer open.',
  trade_stale: 'Someone no longer has the cards for that trade.',
  trade_not_accepted: 'That player hasn’t accepted the offer.',
  skip_not_allowed: 'That player can’t be skipped yet.',
};

export function reasonText(code: string | undefined): string {
  if (code === undefined) return 'Something went wrong. Try again.';
  return TEXT[code] ?? 'Something went wrong. Try again.';
}
