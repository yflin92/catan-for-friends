// V47 / NFR14: first load ≤ 3 s at 10 Mbps. Lighthouse (desktop preset: simulated 10 Mbps = 10,240 Kbps, 40 ms RTT, no
// CPU slowdown) loads the home page from the real server serving the built bundle (apps/web/dist) with its production
// headers and CSP. The app server sends files uncompressed (Caddy compresses in deployment), so this is the heavier case.
// First contentful paint, largest contentful paint and time to interactive must each be ≤ 3 s; the metrics and the
// JSON report are attached to the test result. Chromium only: Lighthouse drives Chrome over the DevTools protocol.
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import { startServer } from '@hexlands/server';
import lighthouse, { desktopConfig } from 'lighthouse';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const BUDGET_MS = 3000;
const METRICS = ['first-contentful-paint', 'largest-contentful-paint', 'interactive'] as const;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr !== null ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

test('V47: the home page loads in ≤ 3 s at 10 Mbps (Lighthouse)', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Lighthouse drives Chrome over the DevTools protocol.');
  test.setTimeout(120_000);
  expect(desktopConfig.settings?.throttling).toMatchObject({ throughputKbps: 10 * 1024, rttMs: 40, cpuSlowdownMultiplier: 1 });

  const server = await startServer({ telemetry: 'memory', port: 0, dbPath: ':memory:', staticDir: DIST });
  const debugPort = await freePort();
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
  try {
    const result = await lighthouse(
      `http://127.0.0.1:${server.port}/`,
      { port: debugPort, output: 'json', logLevel: 'error', onlyCategories: ['performance'] },
      desktopConfig,
    );
    if (result === undefined) throw new Error('Lighthouse returned no result');
    const { lhr, report } = result;
    await testInfo.attach('lighthouse-report.json', { body: Array.isArray(report) ? report[0]! : report, contentType: 'application/json' });
    expect(lhr.runtimeError, lhr.runtimeError?.message).toBeUndefined();
    const ms = Object.fromEntries(METRICS.map((id) => [id, lhr.audits[id]?.numericValue]));
    const bytes = lhr.audits['total-byte-weight']?.numericValue;
    await testInfo.attach('v47-metrics.json', {
      body: JSON.stringify({ ...ms, totalByteWeight: bytes, performanceScore: lhr.categories['performance']?.score }, null, 2),
      contentType: 'application/json',
    });
    for (const id of METRICS) {
      expect(ms[id], `${id} was not measured`).toEqual(expect.any(Number));
      expect(ms[id], `${id} over the ${BUDGET_MS} ms budget`).toBeLessThanOrEqual(BUDGET_MS);
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
