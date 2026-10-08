import { defineConfig, devices } from '@playwright/test';

// Browser end-to-end tests live in ./e2e. CI installs Chromium only.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'github' : 'list',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
