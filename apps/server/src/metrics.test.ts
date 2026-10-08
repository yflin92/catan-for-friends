// The metric catalogue against design §9.2: worst-case series (AC33, V32), enum sources and label keys.
import { ReasonCode } from '@hexlands/engine';
import { CLIENT_ERROR_KINDS, DISCONNECT_REASONS, RECONNECT_OUTCOMES, RESUME_GAP_CAUSES } from '@hexlands/protocol';
import { describe, expect, it } from 'vitest';
import { ALLOWED_LABEL_KEYS, CATALOGUE, INSTRUMENTS, RUNTIME_SERIES_RESERVED, TRANSITION_EDGES, seriesOf, serverMetrics, worstCaseSeries } from './metrics';
import { RUNTIME_INSTRUMENTS } from './runtime-metrics';
import { createTelemetry } from './telemetry';

const ID_LIKE = /(^|[._])(id|ids)$|game|player|seat|room|trace|span|token|name|ip|url/i;

describe('series budget (AC33, design §9.2)', () => {
  it('computes 309 app series from the catalogue and the enum sizes in code, within the 450 budget', () => {
    expect(worstCaseSeries()).toBe(309);
    expect(worstCaseSeries()).toBeLessThanOrEqual(450);
  });

  it('matches the §9.2 worst case of every instrument', () => {
    const expected: Record<string, number> = {
      'catan.action.duration': 65,
      'catan.actions': 5,
      'catan.actions.rejected': 45,
      'catan.errors': 6,
      'catan.http.responses_5xx': 1,
      'catan.rooms.creates': 5,
      'catan.ws.rtt': 13,
      'catan.ws.delivery.duration': 13,
      'catan.client.action_rtt': 13,
      'catan.ws.connections': 1,
      'catan.players.connected': 1,
      'catan.player.connected_seconds': 1,
      'catan.ws.disconnects': 5,
      'catan.ws.reconnects': 4,
      'catan.ws.resume_gap': 24,
      'catan.ws.resume_gap.reports': 2,
      'catan.ws.resume_gap.within_target': 2,
      'catan.games': 3,
      'catan.games.transitions': 7,
      'catan.games.active_play_seconds': 1,
      'catan.game.active_play': 12,
      'catan.persist.duration': 39,
      'catan.games.lost_on_restart': 1,
      'catan.games.restored_on_start': 1,
      'catan.server.starts': 2,
      'catan.job.abandonment.runs': 2,
      'catan.job.abandonment.duration': 13,
      'catan.job.abandonment.last_success': 1,
      'catan.client.errors': 4,
      'catan.telemetry.dropped': 1,
      'catan.disk.free': 1,
    };
    expect(Object.fromEntries(INSTRUMENTS.map((s) => [s.name, seriesOf(s)]))).toEqual(expected);
  });

  it('reserves 15 series for the runtime whitelist; 10 runtime instruments are registered, with unit-free names', () => {
    expect(RUNTIME_SERIES_RESERVED).toBe(15);
    expect(RUNTIME_INSTRUMENTS).toHaveLength(10);
    for (const r of RUNTIME_INSTRUMENTS) expect(r.name, r.name).not.toMatch(/_(seconds|bytes)$|_seconds_total$/);
    expect(RUNTIME_INSTRUMENTS.filter((r) => r.kind === 'counter').map((r) => r.name)).toEqual([
      'catan.runtime.cpu.user',
      'catan.runtime.cpu.system',
    ]);
  });

  it('job duration buckets follow the Evolve review: .001 … 30 s', () => {
    expect(CATALOGUE.jobDuration.boundaries).toEqual([0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1, 5, 30]);
  });
});

describe('closed label enums come from the code', () => {
  it('reason_code is every ReasonCode plus other; rooms.creates includes rate_limited_auth (D16)', () => {
    expect(CATALOGUE.actionsRejected.labels.reason_code).toEqual([...Object.keys(ReasonCode), 'other']);
    expect(Object.keys(ReasonCode)).toHaveLength(44);
    expect(CATALOGUE.roomsCreates.labels.result).toContain('rate_limited_auth');
  });

  it('protocol enums feed the disconnect, reconnect, resume-gap and client-error labels', () => {
    expect(CATALOGUE.wsDisconnects.labels.reason).toBe(DISCONNECT_REASONS);
    expect(CATALOGUE.wsReconnects.labels.outcome).toBe(RECONNECT_OUTCOMES);
    expect(CATALOGUE.wsResumeGap.labels.cause).toBe(RESUME_GAP_CAUSES);
    expect(CATALOGUE.clientErrors.labels.kind).toBe(CLIENT_ERROR_KINDS);
  });

  it('transitions are exactly the 7 valid lifecycle edges, and only those are ever recorded', () => {
    expect(TRANSITION_EDGES.map(([f, t]) => `${f}→${t}`)).toEqual([
      'none→lobby',
      'lobby→active',
      'lobby→expired',
      'active→abandoned',
      'abandoned→active',
      'active→finished',
      'abandoned→expired',
    ]);
    const t = createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'test' });
    const m = serverMetrics(t);
    m.transition('lobby', 'active');
    m.transition('active', 'lobby' as never);
    expect(t.metrics()['catan.games.transitions']?.points).toEqual([{ attributes: { from: 'lobby', to: 'active' }, value: 1 }]);
  });

  it('every latency histogram has its NFR threshold as a bucket boundary', () => {
    expect(CATALOGUE.actionDuration.boundaries).toContain(0.05);
    for (const h of [CATALOGUE.wsRtt, CATALOGUE.wsDelivery, CATALOGUE.clientActionRtt]) expect(h.boundaries).toContain(0.3);
    expect(CATALOGUE.wsResumeGap.boundaries).toContain(5);
  });

  it('every histogram is in seconds with ascending boundaries', () => {
    for (const s of INSTRUMENTS.filter((i) => i.kind === 'histogram')) {
      expect(s.unit, s.name).toBe('s');
      expect([...(s.boundaries ?? [])].sort((a, b) => a - b), s.name).toEqual(s.boundaries);
    }
  });
});

describe('label keys (V32: no id-like keys)', () => {
  it('every catalogue label key is allowed and none looks like an id', () => {
    for (const s of INSTRUMENTS) {
      for (const key of Object.keys(s.labels ?? {})) {
        expect(ALLOWED_LABEL_KEYS.has(key), `${s.name}.${key}`).toBe(true);
        if (key !== 'reason_code') expect(key, `${s.name}.${key}`).not.toMatch(ID_LIKE);
      }
    }
  });

  it('a value outside an instrument enum is recorded as other, and undeclared keys are dropped', () => {
    const t = createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'test' });
    serverMetrics(t).actionsRejected.add(1, { reason_code: 'made_up', game_id: 'g1' });
    expect(t.metrics()['catan.actions.rejected']?.points).toEqual([{ attributes: { reason_code: 'other' }, value: 1 }]);
  });
});
