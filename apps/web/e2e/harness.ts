// End-to-end harness: one in-process Hexlands server (startServer, design §3.12) plus a Vite preview of the built web
// app per Playwright worker. The preview proxies /ws and /api to the server, so pages talk only to their own origin.
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { startServer, type RunningServer, type ServerOptions } from '@hexlands/server';
import { preview, type PreviewServer } from 'vite';
import { serverProxy } from '../vite.config';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST = '127.0.0.1';

export interface Harness {
  readonly server: RunningServer;
  /** Origin of the web app, e.g. http://127.0.0.1:41234. */
  readonly baseURL: string;
}

export type HarnessServerOptions = Omit<ServerOptions, 'port' | 'dbPath' | 'allowedOrigins'>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr !== null ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

export async function startHarness(serverOptions: HarnessServerOptions = {}): Promise<Harness & { close(): Promise<void> }> {
  if (!existsSync(`${WEB_ROOT}/dist/index.html`)) {
    throw new Error('apps/web/dist is missing; run `pnpm --filter @hexlands/web build` before the e2e suite');
  }
  const webPort = await freePort();
  const baseURL = `http://${HOST}:${webPort}`;
  const server = await startServer({
    telemetry: 'memory',
    ...serverOptions,
    port: 0,
    dbPath: ':memory:',
    allowedOrigins: [baseURL, `http://localhost:${webPort}`],
  });
  let web: PreviewServer;
  try {
    web = await preview({
      root: WEB_ROOT,
      logLevel: 'warn',
      preview: { host: HOST, port: webPort, strictPort: true, proxy: serverProxy(`http://${HOST}:${server.port}`) },
    });
  } catch (err) {
    await server.close();
    throw err;
  }
  return {
    server,
    baseURL,
    close: async () => {
      await web.close();
      await server.close();
    },
  };
}

/** Playwright test with a worker-scoped `harness` and `baseURL` pointing at it. Run with workers: 1. */
export const test = base.extend<object, { harness: Harness }>({
  harness: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require an object pattern
    async ({}, use) => {
      const h = await startHarness();
      await use(h);
      await h.close();
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ harness }, use) => {
    await use(harness.baseURL);
  },
});

export { expect } from '@playwright/test';
