import { defineConfig, devices } from '@playwright/test';

/*
 * The port is machine-global; worktrees are not. Two sessions running the suite
 * at once used to land on the same 8099, and `reuseExistingServer` meant the
 * second one silently talked to the first one's server — so it tested the other
 * worktree's build against the other worktree's database, and every spec's
 * `POST /api/test/reset` wiped the other run's flashes mid-test. The failures
 * that produces move around between runs and look like real ones.
 *
 * So the default port is derived from the worktree path: stable within a
 * checkout, so reuse still saves a boot, and different between checkouts, so
 * concurrent runs cannot see each other. E2E_PORT overrides it when you need a
 * specific one. Kept well below the ephemeral range so nothing else claims it.
 */
const portForCwd = (): number => {
  let h = 2166136261;
  for (const ch of process.cwd()) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  return 8100 + (h % 900);
};

const PORT = Number(process.env.E2E_PORT ?? portForCwd());

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
    /*
     * Never adopt a server that is already listening. If the derived port ever
     * does collide, the run must fail loudly with "port already in use" rather
     * than quietly testing someone else's build and truncating their database.
     * The cost is one server boot per run, against a suite that takes minutes.
     */
    reuseExistingServer: false,
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
