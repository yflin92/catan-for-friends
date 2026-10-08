import { defineConfig, devices } from '@playwright/test';

// Browser end-to-end tests live in ./e2e and use the worker-scoped harness in e2e/harness.ts (one in-process server
// plus a Vite preview of dist/ per worker). The suite runs on a single worker. Chromium always runs; with
// HEXLANDS_E2E_BROWSERS=all, Firefox and WebKit run too (the nightly job installs them; the PR job installs Chromium only).
const allBrowsers = process.env['HEXLANDS_E2E_BROWSERS'] === 'all';
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'github' : 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(allBrowsers
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
});
