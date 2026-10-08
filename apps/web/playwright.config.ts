import { defineConfig, devices } from '@playwright/test';
import { liveArtifactsOn, liveBaseURL } from './e2e/live';

// Browser end-to-end tests live in ./e2e and use the worker-scoped harness in e2e/harness.ts (one in-process server
// plus a Vite preview of dist/ per worker). The suite runs on a single worker. Chromium always runs; with
// HEXLANDS_E2E_BROWSERS=all, Firefox and WebKit run too (the nightly job installs them; the PR job installs Chromium only).
// With HEXLANDS_E2E_BASE_URL set (live-smoke.spec.ts against a deployed server), traces, screenshots, video and the
// failure page snapshot are off, since they could hold the room-creation passphrase, room codes or seat tokens;
// HEXLANDS_E2E_LIVE_ARTIFACTS=on turns traces, screenshots and video on, with a warning. HEXLANDS_E2E_LIVE_INSECURE_TLS=yes accepts an untrusted certificate (a local Caddy CA only).
const allBrowsers = process.env['HEXLANDS_E2E_BROWSERS'] === 'all';
const live = liveBaseURL() !== null;
const liveArtifacts = live && liveArtifactsOn();
if (liveArtifacts) console.warn('[live] HEXLANDS_E2E_LIVE_ARTIFACTS=on: traces, screenshots and video may contain secrets; do not share them.');
// When a test has failed, Playwright writes an aria snapshot of the page whose context closes first into
// error-context.md and the HTML report; in the lobby that shows the invite and rejoin links. PLAYWRIGHT_NO_COPY_PROMPT
// is the setting that skips it. This file is evaluated in the workers too.
if (live) process.env['PLAYWRIGHT_NO_COPY_PROMPT'] ??= '1';
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'github' : 'list',
  use: live
    ? {
        trace: liveArtifacts ? 'on' : 'off',
        screenshot: liveArtifacts ? 'on' : 'off',
        video: liveArtifacts ? 'on' : 'off',
        ignoreHTTPSErrors: process.env['HEXLANDS_E2E_LIVE_INSECURE_TLS'] === 'yes',
      }
    : {},
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
