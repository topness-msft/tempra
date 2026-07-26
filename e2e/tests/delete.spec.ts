import { test, expect, type Page } from '@playwright/test';

/**
 * Deleting is the one action in this app that destroys evidence, so these tests
 * are less about "does the row disappear" and more about the guarantees around
 * it: that a scroll never deletes anything, that undo really puts it back, and
 * that nothing reaches the server until the undo window has closed.
 */

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/test/reset');
  await page.goto('/');
  await expect(page.locator('.stage')).toBeVisible();
});

/** Log a flash and land on the history tab with it showing. */
async function logAndOpenHistory(page: Page) {
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();
  await page.locator('[data-tab="history"]').click();
  await expect(page.locator('.swipe')).toHaveCount(1);
}

/** Drag a row horizontally by `dx` pixels, in steps, like a real finger. */
async function drag(page: Page, dx: number, dy = 0) {
  const row = page.locator('.swipe').first();
  const box = await row.boundingBox();
  if (!box) throw new Error('row has no box');
  const x = box.x + box.width - 40;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
  }
  await page.mouse.up();
}

test('swiping a row reveals delete, and deleting removes it', async ({ page }) => {
  await logAndOpenHistory(page);

  await drag(page, -120);
  await expect(page.locator('.swipe.open')).toHaveCount(1);

  await page.locator('[data-del]').click();
  await expect(page.locator('.swipe')).toHaveCount(0);

  // The undo window has to elapse before the server is told anything.
  await expect
    .poll(async () => (await (await page.request.get('/api/flashes')).json()).flashes.length, {
      timeout: 15_000,
    })
    .toBe(0);

  // And the row must still be gone *after* that write lands. Asserting only
  // before it is what let a version ship where the queued delete flushed and
  // left the outbox, so nothing was subtracting it any more and the row came
  // back — the cached server view still listed it. A later refresh does hide it
  // again, but by then the user has watched the thing they deleted return.
  await page.waitForTimeout(1500);
  await expect(page.locator('.swipe')).toHaveCount(0);
  await expect(page.locator('.empty-note')).toBeVisible();
});

test('undo puts the flash back and nothing is ever sent', async ({ page }) => {
  await logAndOpenHistory(page);

  await drag(page, -120);
  await page.locator('[data-del]').click();
  await expect(page.locator('.swipe')).toHaveCount(0);

  await page.locator('.toast-act').click();
  await expect(page.locator('.swipe')).toHaveCount(1);

  // Give the window more than enough time to have fired had it not been cancelled.
  await page.waitForTimeout(7000);
  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes).toHaveLength(1);
});

test('a vertical drag scrolls and never opens a row', async ({ page }) => {
  await logAndOpenHistory(page);

  // The dangerous gesture: a mostly-vertical scroll that drifts sideways.
  await drag(page, -30, 90);

  await expect(page.locator('.swipe.open')).toHaveCount(0);
  await expect(page.locator('.swipe')).toHaveCount(1);
});

test('a short sideways nudge springs back instead of opening', async ({ page }) => {
  await logAndOpenHistory(page);

  await drag(page, -30);

  await expect(page.locator('.swipe.open')).toHaveCount(0);
});

test('deleting works offline and syncs the removal later', async ({ page, context }) => {
  await logAndOpenHistory(page);

  await context.setOffline(true);
  await drag(page, -120);
  await page.locator('[data-del]').click();
  await expect(page.locator('.swipe')).toHaveCount(0);

  // The row must stay gone across the undo window even with nowhere to send it.
  await page.waitForTimeout(7000);
  await expect(page.locator('.swipe')).toHaveCount(0);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect
    .poll(async () => (await (await page.request.get('/api/flashes')).json()).flashes.length, {
      timeout: 15_000,
    })
    .toBe(0);
});
