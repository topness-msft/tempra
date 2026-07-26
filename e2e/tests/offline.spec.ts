import { test, expect } from '@playwright/test';

/**
 * Offline is the whole point. A flash happens at 3am in a house with bad wifi,
 * and the log has to accept it anyway. These tests fail loudly if a queued
 * entry can ever be silently dropped or hidden from the user.
 *
 * Tests that need to reload the page while offline live in pwa-shell.spec.ts;
 * see the note there about WebKit's offline emulation.
 */

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/test/reset');
  await page.goto('/');
  await expect(page.locator('.stage')).toBeVisible();
});

test('a flash logged offline is accepted, queued, and delivered on reconnect', async ({
  page,
  context,
}) => {
  await context.setOffline(true);

  await page.locator('.slider').fill('6');
  await page.locator('[data-sym="sweating"]').click();
  await page.locator('[data-act="begin"]').click();

  // The user must see that it worked. An offline log that looks like a failure
  // gets logged twice, or the app stops being trusted.
  await expect(page.locator('.ribbon')).toBeVisible();
  await expect(page.locator('.sync-bar')).toContainText('1');
  // ...and it must be honest that it has not reached the server yet.
  await expect(page.locator('.ribbon')).toContainText('Saved on this phone');

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync-bar')).toHaveCount(0, { timeout: 10_000 });

  const after = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(after).toHaveLength(1);
  expect(after[0].intensity).toBe(6);
  expect(after[0].symptoms).toEqual(['sweating']);

  // Once synced, the entry stops claiming to be local-only.
  await expect(page.locator('.ribbon')).not.toContainText('Saved on this phone');
});

test('ending a flash offline still records the duration once reconnected', async ({
  page,
  context,
}) => {
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();

  await context.setOffline(true);
  await page.locator('[data-act="open-end"]').click();
  await page.locator('.slider.dur').fill('9');
  await page.locator('[data-act="confirm-end"]').click();

  // The flash reads as finished immediately, not "still running".
  await expect(page.locator('.ribbon')).toHaveCount(0);
  await expect(page.locator('.sync-bar')).toBeVisible();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync-bar')).toHaveCount(0, { timeout: 10_000 });

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes[0].status).toBe('ended');
  expect(flashes[0].durationMin).toBe(9);
});

test('several flashes queued offline all arrive, in order', async ({ page, context }) => {
  await context.setOffline(true);

  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();
  await page.locator('[data-act="open-end"]').click();
  await page.locator('[data-act="confirm-end"]').click();
  await expect(page.locator('.ribbon')).toHaveCount(0);

  await page.locator('.slider').fill('9');
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();

  await expect(page.locator('.sync-bar')).toContainText('3');

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync-bar')).toHaveCount(0, { timeout: 15_000 });

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes).toHaveLength(2);
  // Newest first: the still-running one, then the one that was ended.
  expect(flashes[0].status).toBe('active');
  expect(flashes[0].intensity).toBe(9);
  expect(flashes[1].status).toBe('ended');
});
