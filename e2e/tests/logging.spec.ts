import { test, expect, type Page } from '@playwright/test';

/**
 * These tests are written against the real thing the user does at 3am: open the
 * app, log a flash, come back later and close it. They assert behaviour, not
 * markup, so the design can keep moving without breaking them.
 */

/** Each test starts from an empty database so counts and stats are meaningful. */
async function reset(page: Page) {
  const res = await page.request.post('/api/test/reset');
  expect(res.ok(), 'test reset endpoint must be enabled').toBeTruthy();
}

test.beforeEach(async ({ page }) => {
  await reset(page);
  await page.goto('/');
  await expect(page.locator('.stage')).toBeVisible();
});

test('logging a flash surfaces it as the active ribbon', async ({ page }) => {
  await expect(page.locator('.ribbon')).toHaveCount(0);
  await expect(page.getByText('Nothing running right now')).toBeVisible();

  await page.locator('[data-act="begin"]').click();

  const ribbon = page.locator('.ribbon');
  await expect(ribbon).toBeVisible();
  // The elapsed clock is the proof it is genuinely running, not just recorded.
  await expect(ribbon).toContainText(/\d+:\d\d/);
  await expect(page.locator('[data-act="open-end"]')).toBeVisible();
});

test('intensity and symptoms are carried into the saved flash', async ({ page }) => {
  await page.locator('.slider').fill('8');
  await expect(page.locator('.gauge .val')).toContainText('8');
  await expect(page.locator('.gauge .word')).toContainText(/severe/i);

  await page.locator('[data-sym="sweating"]').click();
  await page.locator('[data-sym="palpitations"]').click();
  await page.locator('[data-act="begin"]').click();

  await expect(page.locator('.ribbon')).toBeVisible();

  const flashes = await (await page.request.get('/api/flashes')).json();
  expect(flashes.flashes).toHaveLength(1);
  expect(flashes.flashes[0].intensity).toBe(8);
  expect(flashes.flashes[0].symptoms.sort()).toEqual(['palpitations', 'sweating']);
});

test('ending a flash prefills the measured duration and records it', async ({ page }) => {
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();

  await page.locator('[data-act="open-end"]').click();

  // The duration is measured, not guessed: the field arrives already filled.
  const confirm = page.locator('[data-act="confirm-end"]');
  await expect(confirm).toContainText(/Confirm end · \d+ min/);

  await page.locator('.slider.dur').fill('12');
  await expect(confirm).toContainText('12 min');
  await confirm.click();

  await expect(page.locator('.ribbon')).toHaveCount(0);

  const flashes = await (await page.request.get('/api/flashes')).json();
  expect(flashes.flashes[0].status).toBe('ended');
  expect(flashes.flashes[0].durationMin).toBe(12);
});

test('backing out of the end screen leaves the flash running', async ({ page }) => {
  await page.locator('[data-act="begin"]').click();
  await page.locator('[data-act="open-end"]').click();
  await page.locator('[data-act="cancel-end"]').last().click();

  // Staying open is the default state, not an action.
  await expect(page.locator('.ribbon')).toBeVisible();
  const flashes = await (await page.request.get('/api/flashes')).json();
  expect(flashes.flashes[0].status).toBe('active');
  expect(flashes.flashes[0].endedAt).toBeNull();
});

test('a flash started from a Shortcut supersedes the running one without inventing a duration', async ({
  page,
}) => {
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();

  // The in-app CTA deliberately cannot start a second flash while one runs — it
  // becomes "Save these details" instead. Supersession only happens from the
  // Shortcut or the bedside button, so that is the path worth testing.
  await expect(page.locator('[data-act="save"]')).toBeVisible();
  await expect(page.locator('[data-act="begin"]')).toHaveCount(0);

  const res = await page.request.post('/api/flashes', {
    data: { intensity: 5, source: 'shortcut' },
  });
  expect(res.status()).toBe(201);

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes).toHaveLength(2);
  const superseded = flashes.find((f: { status: string }) => f.status === 'superseded');
  expect(superseded, 'the earlier flash should be superseded').toBeTruthy();
  // Auto-closing must never fabricate a duration the user did not observe.
  expect(superseded.endedAt).toBeNull();
  expect(superseded.durationMin).toBeNull();

  // Exactly one flash may be active at a time.
  expect(flashes.filter((f: { status: string }) => f.status === 'active')).toHaveLength(1);
});

test('the log screen edits the running flash instead of overwriting it with defaults', async ({
  page,
}) => {
  await page.locator('.slider').fill('9');
  await page.locator('[data-sym="chills"]').click();
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();

  // Reopening mid-flash must show what was recorded, not the blank defaults.
  await page.reload();
  await expect(page.locator('.ribbon')).toBeVisible();
  await expect(page.locator('.gauge .val')).toContainText('9');
  await expect(page.locator('[data-sym="chills"]')).toHaveAttribute('aria-pressed', 'true');

  // Saving without touching anything must not invent a new intensity.
  await page.locator('[data-act="save"]').click();
  await expect(page.locator('.ribbon')).toContainText('Intensity 9');

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes[0].intensity).toBe(9);
  expect(flashes[0].symptoms).toEqual(['chills']);
});

test('history shows the day summary and the entry', async ({ page }) => {
  await page.locator('.slider').fill('7');
  await page.locator('[data-sym="chills"]').click();
  await page.locator('[data-act="begin"]').click();

  await page.locator('[data-tab="history"]').click();

  await expect(page.locator('.stats')).toContainText('1');
  await expect(page.locator('.entry').first()).toBeVisible();
  await expect(page.locator('.scroll')).toContainText(/chills/i);
});

test('export offers both formats and the CSV downloads with real rows', async ({ page }) => {
  await page.locator('[data-act="begin"]').click();
  await page.locator('[data-tab="export"]').click();

  await expect(page.getByText('Spreadsheet (CSV)')).toBeVisible();
  await expect(page.getByText('Everything (JSON)')).toBeVisible();

  const csv = await page.request.get('/api/export.csv');
  expect(csv.ok()).toBeTruthy();
  expect(csv.headers()['content-disposition']).toMatch(/tempra-export-\d{4}-\d{2}-\d{2}\.csv/);
  const body = await csv.text();
  const lines = body.trim().split(/\r?\n/);
  expect(lines.length, 'header plus one logged flash').toBe(2);
  expect(lines[0]).toContain('started_local');
  expect(lines[0]).toContain('started_utc');
  expect(lines[1]).toContain('active');
});
