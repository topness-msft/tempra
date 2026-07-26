import { test, expect } from '@playwright/test';

/**
 * Service-worker tests run on Chromium rather than WebKit.
 *
 * Playwright's WebKit offline emulation aborts navigations before the service
 * worker can answer them ("WebKit encountered an internal error"), so an offline
 * reload fails there even when the shell is correctly cached — verified by
 * inspecting the caches directly. The behaviour under test is the service worker
 * spec, which Chromium exercises faithfully. Everything user-facing still runs
 * on WebKit in the other specs.
 */

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/test/reset');
  await page.goto('/');
  await expect(page.locator('.stage')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker?.ready);
});

test('the app shell opens with no network at all', async ({ page, context }) => {
  await context.setOffline(true);
  await page.reload();

  // Not an error page: the real UI, ready to accept a flash.
  await expect(page.locator('[data-act="begin"]')).toBeVisible();
  await expect(page.locator('.slider')).toBeVisible();
});

test('the bundled typeface survives going offline', async ({ page }) => {
  const cached = await page.evaluate(async () => {
    // Found by suffix rather than by name: the cache is versioned, and pinning
    // the version here meant a routine bump silently opened an empty cache and
    // failed a test that was actually still passing.
    const name = (await caches.keys()).find((k) => k.endsWith('-assets'));
    if (!name) return [];
    const cache = await caches.open(name);
    const keys = await cache.keys();
    return keys.map((r) => new URL(r.url).pathname);
  });

  // Fonts are referenced from inside the CSS, so they are easy to miss when
  // precaching. Losing them would leave the app readable but in the wrong
  // typeface exactly when it is offline.
  expect(cached.filter((p) => p.endsWith('.woff2')).length).toBeGreaterThan(0);
  expect(cached.some((p) => p.endsWith('.css'))).toBeTruthy();
  expect(cached.some((p) => p.endsWith('.js'))).toBeTruthy();
});

test('a queued flash survives the app being closed and reopened', async ({ page, context }) => {
  await context.setOffline(true);
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();

  // Phone locked, Safari evicted the tab, user comes back later.
  await page.reload();
  await expect(page.locator('.ribbon')).toBeVisible();
  await expect(page.locator('.sync-bar')).toContainText('1');

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync-bar')).toHaveCount(0, { timeout: 10_000 });

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes).toHaveLength(1);
});

test('API responses are never served from the service worker cache', async ({ page }) => {
  // The app keeps its own snapshot in localStorage. A second, invisible cache
  // could disagree with it, which at 3am looks exactly like lost data.
  const cachedApi = await page.evaluate(async () => {
    const names = await caches.keys();
    const found: string[] = [];
    for (const name of names) {
      const keys = await (await caches.open(name)).keys();
      for (const req of keys) {
        const { pathname } = new URL(req.url);
        if (pathname.startsWith('/api/') || pathname.startsWith('/hooks/')) found.push(pathname);
      }
    }
    return found;
  });
  expect(cachedApi).toEqual([]);
});
