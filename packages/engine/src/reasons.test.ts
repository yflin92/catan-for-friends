import { describe, expect, expectTypeOf, it } from 'vitest';
import { ReasonCode, reasonCategory, type EngineReasonCode, type OutcomeResult, type ResultCategory } from './reasons';

const EXPECTED: Record<ResultCategory, readonly string[]> = {
  turn: ['not_your_turn', 'wrong_phase', 'discard_pending'],
  rule: [
    'insufficient_resources', 'no_pieces_left', 'invalid_location', 'occupied', 'distance_rule', 'not_connected',
    'robber_must_move', 'invalid_robber_hex', 'invalid_steal_target', 'wrong_discard_count', 'discard_not_required',
    'dev_deck_empty', 'dev_card_not_owned', 'dev_card_bought_this_turn', 'dev_card_already_played', 'bank_insufficient',
    'invalid_trade', 'trade_not_found', 'trade_stale', 'trade_not_accepted', 'room_full', 'name_taken', 'invalid_name',
    'game_already_started', 'not_enough_players', 'capacity_reached', 'skip_not_allowed', 'game_over', 'game_expired',
    'action_id_reused', 'malformed_action',
  ],
  auth: ['bad_seat_token', 'token_room_mismatch', 'unknown_room', 'seat_superseded', 'seat_token_revoked', 'not_host',
    'rate_limited_auth'],
  error: ['internal_error', 'server_draining', 'rate_limited'],
};

describe('ReasonCode (design §3.8, P5)', () => {
  it('has exactly 44 codes', () => {
    expect(Object.keys(ReasonCode)).toHaveLength(44);
  });

  it.each(Object.entries(EXPECTED))('has exactly the listed %s codes', (category, codes) => {
    const actual = Object.entries(ReasonCode).filter(([, c]) => c === category).map(([code]) => code);
    expect(actual.sort()).toEqual([...codes].sort());
  });

  it('has 3 turn, 31 rule, 7 auth and 3 error codes', () => {
    expect([EXPECTED.turn.length, EXPECTED.rule.length, EXPECTED.auth.length, EXPECTED.error.length]).toEqual([3, 31, 7, 3]);
  });

  it('reasonCategory is total and agrees with the map', () => {
    for (const code of Object.keys(ReasonCode) as ReasonCode[]) {
      expect(reasonCategory(code)).toBe(ReasonCode[code]);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ReasonCode)).toBe(true);
  });

  it('does not contain the HTTP-only bad_passphrase', () => {
    expect('bad_passphrase' in ReasonCode).toBe(false);
  });

  it('types: EngineReasonCode is a 27-code subset and OutcomeResult is closed', () => {
    expectTypeOf<EngineReasonCode>().toExtend<ReasonCode>();
    expectTypeOf<'game_expired'>().not.toExtend<EngineReasonCode>();
    expectTypeOf<'not_host'>().not.toExtend<EngineReasonCode>();
    expectTypeOf<'internal_error'>().toExtend<EngineReasonCode>();
    expectTypeOf<OutcomeResult>().toEqualTypeOf<'ok' | 'rule' | 'turn' | 'auth' | 'error'>();
  });
});
