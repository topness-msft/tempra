import { defineConfig, devices } from '@playwright/test';

const PORT = 8099;

export default defineConfig({
  testDir: './e2e/tests',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // The only device that matters for v1. Layout assertions are written
      // against this viewport deliberately, not a generic desktop one.
      name: 'iphone-15-pro',
      use: { ...devices['iPhone 14 Pro'] },
      testIgnore: /pwa-shell\.spec\.ts/,
    },
    {
      // Service-worker specs only. Playwright's WebKit offline emulation aborts
      // navigations before the service worker can answer, so offline reloads
      // cannot be tested there; Chromium implements the spec faithfully.
      name: 'mobile-chrome-pwa',
      use: { ...devices['Pixel 7'] },
      testMatch: /pwa-shell\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'node packages/server/dist/index.js',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: './data/e2e',
      DB_FILE: 'e2e.db',
      LOG_LEVEL: 'warn',
      // Lets each spec start from an empty history. Refuses to switch on in
      // production or alongside a passphrase; see config.allowTestReset.
      ALLOW_TEST_RESET: '1',
    },
  },
});
