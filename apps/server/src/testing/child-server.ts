// A Hexlands server in its own process, for SIGTERM/SIGKILL tests (V23, V24; TH9 'crash'). Run with
//   node --experimental-transform-types --import ./tooling/ts-resolve-hook.mjs apps/server/src/testing/child-server.ts
// and NODE_ENV=test. HEXLANDS_CHILD holds JSON {dbPath, config?, faults?: [{point, action, seq?, times?}]}. The process
// prints `READY <port>` once listening, and drains then exits(0) on SIGTERM/SIGINT.
import { startServer } from '../server';
import { exitOnShutdownSignals } from '../shutdown';
import type { DeepPartial } from '../config';
import type { ServerConfig } from '@hexlands/engine';
import type { FaultAction, FaultPoint } from '../faults';
import { ArmableFaults } from './index';

export interface ChildSpec {
  readonly dbPath: string;
  readonly config?: DeepPartial<ServerConfig>;
  readonly faults?: readonly { point: FaultPoint; action: FaultAction; seq?: number; times?: number }[];
}

const spec = JSON.parse(process.env['HEXLANDS_CHILD'] ?? '{}') as ChildSpec;
const faults = new ArmableFaults();
for (const f of spec.faults ?? []) {
  faults.arm(f.point, f.action, { ...(f.seq !== undefined ? { seq: f.seq } : {}), ...(f.times !== undefined ? { times: f.times } : {}) });
}
const server = await startServer({ port: 0, dbPath: spec.dbPath, telemetry: 'off', faults, ...(spec.config ? { config: spec.config } : {}) });
exitOnShutdownSignals(server);
process.stdout.write(`READY ${server.port}\n`);
