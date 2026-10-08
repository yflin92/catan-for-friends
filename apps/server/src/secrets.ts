// Known-secret registry (design §3.12, TH12). Every mint of a room code or seat token calls record(), so the AC30 scan
// can search telemetry and logs for the exact values. Production uses NoSecrets; startServer installs a caller-supplied
// registry only when test hooks are enabled (see test-hooks.ts).

export type SecretKind = 'roomCode' | 'seatToken';

export interface SecretRegistry {
  record(kind: SecretKind, value: string): void;
}

export const NoSecrets: SecretRegistry = Object.freeze({ record: () => undefined });
