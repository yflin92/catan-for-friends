import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, '../.github/scripts/retry.sh');
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, RETRY_BACKOFF_SECONDS: '0', ...env } });

describe('CI install retry helper (.github/scripts/retry.sh)', () => {
  it('succeeds on the first attempt without retrying', () => {
    const r = run(['3', '5', '--', 'true']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('succeeded on attempt 1/3');
  });

  it('retries after a (forced) failure and then succeeds', () => {
    const r = run(['2', '5', '--', 'true'], { RETRY_FORCE_FAILURES: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('attempt 1/2 forced to fail');
    expect(r.stdout).toContain('succeeded on attempt 2/2');
  });

  it('kills a hanging attempt at its timeout and fails after the last attempt', () => {
    const r = run(['1', '1', '--', 'sleep', '5']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('timed out after 1s');
    expect(r.stdout).toContain('all 1 attempts failed');
  }, 20_000);
});
