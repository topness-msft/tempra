import { test, expect } from '@playwright/test';

/**
 * Day check-ins: the symptoms that are not episodes.
 *
 * The two things these tests exist to protect are the honesty rule — an
 * untouched symptom is recorded as nothing, which is not the same as None —
 * and the fact that a check-in is keyed on the date, so it survives being
 * written offline and replayed.
 */

const today = (): string => {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/test/reset');
  await page.goto('/');
  await expect(page.locator('.stage')).toBeVisible();
});

test('the log screen is unchanged: Begin flash is still one tap away', async ({ page }) => {
  // The whole reason day check-ins live behind their own tab. Nothing may come
  // between a half-awake thumb and this button.
  await expect(page.locator('[data-act="begin"]')).toBeVisible();
  await expect(page.locator('.cta .btn-primary')).toHaveCount(1);
  await expect(page.locator('.tabs a')).toHaveCount(4);
});

test('recording a day check-in saves each tap, with no submit button', async ({ page }) => {
  await page.locator('[data-tab="day"]').click();
  await expect(page.locator('.daypick')).toBeVisible();

  await page.locator('[data-sev="tinnitus:2"]').click();
  await page.locator('[data-sev="sleep:3"]').click();
  // None is a deliberate observation, not an empty answer.
  await page.locator('[data-sev="joint_pain:0"]').click();

  await expect(page.locator('.kicker')).toContainText('3 reported');
  await expect(page.locator('[data-sev="tinnitus:2"]')).toHaveAttribute('aria-pressed', 'true');

  await expect
    .poll(async () => (await (await page.request.get('/api/days')).json()).days.length)
    .toBe(1);

  const day = (await (await page.request.get('/api/days')).json()).days[0];
  expect(day.date).toBe(today());
  // Vocabulary order, matching the order she was asked on screen.
  expect(day.symptoms).toEqual([
    { symptom: 'sleep', severity: 3 },
    { symptom: 'tinnitus', severity: 2 },
    { symptom: 'joint_pain', severity: 0 },
  ]);
});

/*
 * Heart racing is tracked in two vocabularies at once: during a flash, and as a
 * thing that ran all day on its own. It lives behind "more" on the day screen,
 * so this checks it is actually reachable there and stores under the same key
 * the flash tiles use.
 */
test('heart racing can be logged for the whole day, not just during a flash', async ({ page }) => {
  await page.locator('[data-tab="day"]').click();

  // Not on screen until asked for: the first six are what she sees by default.
  await expect(page.locator('[data-sev="palpitations:2"]')).toHaveCount(0);
  await page.locator('[data-daymore="1"]').click();

  await page.locator('[data-sev="palpitations:2"]').click();
  await expect(page.locator('[data-sev="palpitations:2"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await expect
    .poll(async () => (await (await page.request.get('/api/days')).json()).days.length)
    .toBe(1);

  const day = (await (await page.request.get('/api/days')).json()).days[0];
  expect(day.symptoms).toEqual([{ symptom: 'palpitations', severity: 2 }]);
});

test('a symptom she never touched is stored as nothing at all', async ({ page }) => {
  await page.locator('[data-tab="day"]').click();
  await page.locator('[data-sev="tinnitus:1"]').click();

  await expect
    .poll(async () => (await (await page.request.get('/api/days')).json()).days.length)
    .toBe(1);

  const day = (await (await page.request.get('/api/days')).json()).days[0];
  // Only the one she answered. Fatigue is absent, not zero.
  expect(day.symptoms).toEqual([{ symptom: 'tinnitus', severity: 1 }]);
  expect(day.symptoms.map((s: { symptom: string }) => s.symptom)).not.toContain('fatigue');
});

test('tapping the chosen severity again takes it back to unsaid', async ({ page }) => {
  await page.locator('[data-tab="day"]').click();
  await page.locator('[data-sev="tinnitus:2"]').click();
  // The tinnitus row, not the first on screen — sleep is asked first.
  const row = page.locator('.dayrow').filter({ hasText: 'Tinnitus' });
  await expect(row.locator('.nm i')).not.toContainText('Not said');

  await page.locator('[data-sev="tinnitus:2"]').click();
  await expect(page.locator('[data-sev="tinnitus:2"]')).toHaveAttribute('aria-pressed', 'false');

  // Emptied out entirely, the check-in stops existing rather than becoming a
  // blank one that reads as "nothing was wrong".
  await expect
    .poll(async () => (await (await page.request.get('/api/days')).json()).days.length)
    .toBe(0);
});

test('history shows the day as a band above that day’s flashes', async ({ page }) => {
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();

  await page.locator('[data-tab="day"]').click();
  await page.locator('[data-sev="tinnitus:2"]').click();

  await page.locator('[data-tab="history"]').click();
  await expect(page.locator('.dayband .chip')).toContainText('Tinnitus · moderate');
  // Both records, one group, and the band is above the timed rows.
  await expect(page.locator('.daygroup').first().locator('.entry')).toHaveCount(1);
  await expect(page.locator('.statshead')).toHaveCount(2);
});

test('a day with a check-in and no flashes is still a day worth showing', async ({ page }) => {
  await page.locator('[data-tab="day"]').click();
  await page.locator('[data-sev="sleep:3"]').click();

  await page.locator('[data-tab="history"]').click();
  await expect(page.locator('.daygroup')).toHaveCount(1);
  await expect(page.locator('.quiet-day')).toContainText('No flashes');
});

test('history shows only what troubled her, not the symptoms she cleared', async ({ page }) => {
  await page.locator('[data-tab="day"]').click();
  await page.locator('[data-sev="tinnitus:2"]').click();
  await page.locator('[data-sev="joint_pain:0"]').click();

  await page.locator('[data-tab="history"]').click();
  // A row of "none" chips would bury the one that matters.
  await expect(page.locator('.dayband .chip')).toHaveCount(1);
  await expect(page.locator('.dayband')).toContainText('Tinnitus · moderate');
  await expect(page.locator('.dayband')).not.toContainText('Joint pain');

  // Still in the record, though — history is a summary, not the archive.
  const day = (await (await page.request.get('/api/days')).json()).days[0];
  expect(day.symptoms).toContainEqual({ symptom: 'joint_pain', severity: 0 });
});

test('a day she checked and found nothing wrong says so', async ({ page }) => {
  await page.locator('[data-tab="day"]').click();
  await page.locator('[data-sev="tinnitus:0"]').click();

  await page.locator('[data-tab="history"]').click();
  // Distinct from "No check-in for this day", which would be a different fact.
  await expect(page.locator('.dayband')).toContainText('nothing to report');
  await expect(page.locator('.dayband .chip')).toHaveCount(0);
});

test('a check-in written offline is queued and delivered on reconnect', async ({
  page,
  context,
}) => {
  await context.setOffline(true);

  await page.locator('[data-tab="day"]').click();
  await page.locator('[data-sev="tinnitus:2"]').click();
  await page.locator('[data-sev="sleep:3"]').click();

  // She must see it took, and see that it has not reached the server yet.
  await expect(page.locator('.kicker')).toContainText('2 reported');
  await expect(page.locator('.sync-bar')).toBeVisible();
  // A day is one upserted record, so fiddling with it offline leaves exactly
  // one queued write, not one per tap.
  await expect(page.locator('.sync-bar')).toContainText('1');

  await page.locator('[data-tab="history"]').click();
  await expect(page.locator('.dayband .pending-dot')).toBeVisible();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync-bar')).toHaveCount(0, { timeout: 10_000 });

  const days = (await (await page.request.get('/api/days')).json()).days;
  expect(days).toHaveLength(1);
  expect(days[0].date).toBe(today());
  expect(days[0].symptoms).toEqual([
    { symptom: 'sleep', severity: 3 },
    { symptom: 'tinnitus', severity: 2 },
  ]);

  await expect(page.locator('.dayband .pending-dot')).toHaveCount(0);
});

test('yesterday can be filled in this morning, and tomorrow cannot', async ({ page }) => {
  await page.locator('[data-tab="day"]').click();
  await expect(page.locator('[data-act="day-next"]')).toBeDisabled();

  await page.locator('[data-act="day-prev"]').click();
  await expect(page.locator('.daypick .lbl b')).toContainText('Yesterday');
  await page.locator('[data-sev="sleep:3"]').click();

  await expect
    .poll(async () => (await (await page.request.get('/api/days')).json()).days.length)
    .toBe(1);

  const days = (await (await page.request.get('/api/days')).json()).days;
  expect(days[0].date).not.toBe(today());

  // Today is still untouched: the two days are separate records.
  await page.locator('[data-act="day-next"]').click();
  await expect(page.locator('.kicker')).toContainText('Nothing reported yet');
});
