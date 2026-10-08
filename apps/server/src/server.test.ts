import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer, type ServerOptions } from './server';
import { ArmableFaults, FakeClock, RecordingSecrets } from './testing';

const servers: RunningServer[] = [];
async function boot(opts: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const s = await startServer({ port: 0, dbPath: ':memory:', telemetry: 'memory', ...opts });
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function status(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  const apply = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(patch);
  return fn().finally(() => apply(saved));
}

describe('startServer (TH9)', () => {
  it('boots on an ephemeral port with an in-memory store and closes cleanly', async () => {
    const s = await boot({ clock: new FakeClock(0) });
    expect(s.port).toBeGreaterThan(0);
    expect(await status(s.port, '/nothing-here')).toBe(404);
    await s.close();
    await s.close();
    await expect(status(s.port, '/')).rejects.toThrow();
  });

  it('accepts WebSocket upgrades on /ws only, and closes them on close()', async () => {
    const s = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    const other = new WebSocket(`ws://127.0.0.1:${s.port}/other`);
    await expect(new Promise((resolve, reject) => other.once('open', resolve).once('error', reject))).rejects.toThrow();
    await s.close();
    expect(await closed).toBe(1001);
  });

  it('runs two instances side by side', async () => {
    const [a, b] = await Promise.all([boot(), boot()]);
    expect(a.port).not.toBe(b.port);
  });

  it('rejects an invalid config override, naming the key', async () => {
    await expect(startServer({ port: 0, dbPath: ':memory:', config: { ops: { maxMsgsPerSecPerConn: 0 } } })).rejects.toThrow(
      /ops\.maxMsgsPerSecPerConn/,
    );
  });

  it('rejects an empty dbPath', async () => {
    await expect(startServer({ port: 0, dbPath: '' })).rejects.toThrow(/dbPath/);
  });

  it('exposes the hook surface: runAbandonmentJob, drain, stateHash', async () => {
    const s = await boot();
    expect(() => s.runAbandonmentJob()).not.toThrow();
    expect(s.stateHash('ABCDEF')).toBeNull();
    await s.drain();
    await s.drain();
  });

  it("exposes in-memory telemetry with mode 'memory' and empty accessors otherwise (TH10)", async () => {
    const off = await boot({ telemetry: 'off' });
    expect(off.telemetry.metrics()).toEqual({});
    expect(off.telemetry.spans()).toEqual([]);
    expect(off.telemetry.logs()).toEqual([]);
  });
});

describe('test-hook gating (TH9, TH12, ruling G5)', () => {
  it('honours hooks under NODE_ENV=test without a warning', async () => {
    const s = await withEnv({ NODE_ENV: 'test', HEXLANDS_TEST_HOOKS: undefined }, () =>
      boot({ faults: new ArmableFaults(), secrets: new RecordingSecrets(), testHooks: {} }),
    );
    expect(s.telemetry.logs()).toEqual([]);
  });

  it('honours hooks with HEXLANDS_TEST_HOOKS=1 outside NODE_ENV=test', async () => {
    const s = await withEnv({ NODE_ENV: 'production', HEXLANDS_TEST_HOOKS: '1' }, () => boot({ faults: new ArmableFaults() }));
    expect(s.telemetry.logs()).toEqual([]);
  });

  it('ignores faults, secrets and testHooks without the flag and logs one WARN server.test_hooks_ignored', async () => {
    const s = await withEnv({ NODE_ENV: 'production', HEXLANDS_TEST_HOOKS: undefined }, () =>
      boot({ faults: new ArmableFaults(), secrets: new RecordingSecrets(), testHooks: { seedFor: () => undefined } }),
    );
    const events = s.telemetry.logs().map((r) => JSON.parse(r.body as string) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'server.test_hooks_ignored', severity_text: 'WARN', service_name: 'catan-server' });
    expect(s.stateHash('ABCDEF')).toBeNull();
  });

  it('logs nothing when no hook is supplied without the flag', async () => {
    const s = await withEnv({ NODE_ENV: 'production', HEXLANDS_TEST_HOOKS: undefined }, () => boot());
    expect(s.telemetry.logs()).toEqual([]);
  });
});

describe('config per instance (TH16)', () => {
  it('reads env HEXLANDS_* when startServer is called', async () => {
    await withEnv({ HEXLANDS_OPS_MAX_MSGS_PER_SEC_PER_CONN: 'zero' }, async () => {
      await expect(startServer({ port: 0, dbPath: ':memory:' })).rejects.toThrow(/HEXLANDS_OPS_MAX_MSGS_PER_SEC_PER_CONN/);
    });
  });
});
