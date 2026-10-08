import { defineConfig, devices } from '@playwright/test';

// Browser end-to-end tests live in ./e2e and use the worker-scoped harness in e2e/harness.ts (one in-process server
// plus a Vite preview of dist/ per worker). The suite runs on a single worker. CI installs Chromium only.
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'github' : 'list',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
