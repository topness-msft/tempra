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
  // Ending lives on the main button, not in the ribbon: one way out, not two.
  await expect(page.locator('[data-act="end-flash"]')).toBeVisible();
  await expect(ribbon.locator('button')).toHaveCount(0);
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

  await page.locator('[data-act="end-flash"]').click();

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
  await page.locator('[data-act="end-flash"]').click();
  await page.locator('[data-act="cancel-end"]').last().click();

  // Staying open is the default state, not an action.
  await expect(page.locator('.ribbon')).toBeVisible();
  const flashes = await (await page.request.get('/api/flashes')).json();
  expect(flashes.flashes[0].status).toBe('active');
  expect(flashes.flashes[0].endedAt).toBeNull();
});

/*
 * A second flash can arrive before the first is over. She must be able to log it
 * without first pretending to know when the previous one stopped.
 */
test('a second flash can be started in-app while one is still running', async ({ page }) => {
  await page.locator('.slider').fill('7');
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();

  await page.locator('[data-act="compose-new"]').click();

  // The controls reset to blank defaults for the new flash, rather than
  // carrying over the running one's recorded intensity.
  await expect(page.locator('.gauge .val')).toContainText('4');
  await expect(page.locator('.ctanote')).toContainText('no end time');
  // The one still running stays visible above.
  await expect(page.locator('.ribbon')).toBeVisible();

  await page.locator('.slider').fill('9');
  await page.locator('[data-act="begin"]').click();

  await expect(page.locator('.ribbon')).toContainText('Intensity 9');

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes).toHaveLength(2);
  const superseded = flashes.find((f: { status: string }) => f.status === 'superseded');
  expect(superseded.intensity).toBe(7);
  expect(superseded.endedAt).toBeNull();
  expect(superseded.durationMin).toBeNull();
  expect(flashes.filter((f: { status: string }) => f.status === 'active')).toHaveLength(1);
});

test('backing out of composing a second flash returns to editing the running one', async ({
  page,
}) => {
  await page.locator('.slider').fill('7');
  await page.locator('[data-act="begin"]').click();
  await page.locator('[data-act="compose-new"]').click();
  await page.locator('[data-act="cancel-new"]').click();

  // The controls go back to showing the running flash, not blank defaults.
  await expect(page.locator('.gauge .val')).toContainText('7');
  await expect(page.locator('[data-act="end-flash"]')).toBeVisible();

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes).toHaveLength(1);
});

/*
 * The likeliest flash of all is the one she sleeps through. Hours later the
 * timer is not evidence of anything, so the app must stop offering it as one.
 */
test('a flash that ran past an hour is closed without a fabricated duration', async ({ page }) => {
  const startedAt = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
  const res = await page.request.post('/api/flashes', { data: { startedAt, source: 'homekit' } });
  expect(res.status()).toBe(201);

  await page.reload();
  await page.locator('[data-act="end-flash"]').click();

  const confirm = page.locator('[data-act="confirm-end"]');
  await expect(confirm).toHaveText('Close without a duration');
  // No slider is offered by default: there is nothing honest to prefill it with.
  await expect(page.locator('.slider.dur')).toHaveCount(0);
  await confirm.click();

  await expect(page.locator('.ribbon')).toHaveCount(0);

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes[0].status).toBe('ended');
  expect(flashes[0].endedAt).toBeNull();
  expect(flashes[0].durationMin).toBeNull();
});

test('an overrun flash still accepts a duration she remembers, capped at an hour', async ({
  page,
}) => {
  const startedAt = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
  await page.request.post('/api/flashes', { data: { startedAt, source: 'homekit' } });

  await page.reload();
  await page.locator('[data-act="end-flash"]').click();
  await page.locator('[data-act="end-manual"]').click();

  const slider = page.locator('.slider.dur');
  await expect(slider).toHaveAttribute('max', '60');
  await slider.fill('25');
  await page.locator('[data-act="confirm-end"]').click();

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes[0].durationMin).toBe(25);
});

test('a flash started from a Shortcut supersedes the running one without inventing a duration', async ({
  page,
}) => {
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();

  // With a flash running the main button ends it; starting another is a
  // deliberate, separate action. Both paths supersede, and neither invents a
  // duration.
  await expect(page.locator('[data-act="end-flash"]')).toBeVisible();
  await expect(page.locator('[data-act="compose-new"]')).toBeVisible();

  const res = await page.request.post('/api/flashes', {
    // A shortcut firing seconds after any other flash is debounced as a repeat,
    // so name the moment to say this is a separate one. That is the honest
    // shape of the case anyway: two flashes this close apart is a claim you
    // have to make deliberately.
    data: { intensity: 5, source: 'shortcut', startedAt: new Date().toISOString() },
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

test('saying it to Siri twice because you were not sure logs one flash', async ({ page }) => {
  // She cannot see whether Siri worked, so she repeats herself. Two requests,
  // one flash — and the second still gets a whole flash back so the shortcut
  // can tell her when it started rather than reporting a failure.
  const first = await page.request.post('/api/flashes', { data: { source: 'shortcut' } });
  expect(first.status()).toBe(201);

  const second = await page.request.post('/api/flashes', { data: { source: 'shortcut' } });
  expect(second.status()).toBe(200);
  expect((await second.json()).id).toBe((await first.json()).id);

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes).toHaveLength(1);

  // And the one flash is hers to see, not a silently dropped write.
  await page.reload();
  await expect(page.locator('.ribbon')).toBeVisible();
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

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes[0].intensity).toBe(9);
  expect(flashes[0].symptoms).toEqual(['chills']);
});

/*
 * There is no save button while a flash is running. A symptom noticed at 3am is
 * recorded the moment it is tapped, so putting the phone down loses nothing —
 * which is the only assumption safe to make about the middle of the night.
 */
test('details tapped during a running flash are recorded without a save', async ({ page }) => {
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();

  await page.locator('[data-sym="sweating"]').click();
  await expect(page.locator('[data-sym="sweating"]')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => (await (await page.request.get('/api/flashes')).json()).flashes[0].symptoms)
    .toEqual(['sweating']);

  // The intensity follows on release rather than per pixel of the drag.
  await page.locator('.slider').fill('8');
  await expect
    .poll(async () => (await (await page.request.get('/api/flashes')).json()).flashes[0].intensity)
    .toBe(8);

  // The note follows on blur, the same rule the day check-in uses.
  await page.locator('#note').fill('Woke up soaked');
  await page.locator('#note').blur();
  await expect
    .poll(async () => (await (await page.request.get('/api/flashes')).json()).flashes[0].note)
    .toBe('Woke up soaked');
});

/*
 * The closing note is offered as something to add. Now that the note kept during
 * the flash saves itself, there is nearly always one there to destroy.
 */
test('a closing note is added to the note kept during the flash, not swapped for it', async ({
  page,
}) => {
  await page.locator('[data-act="begin"]').click();
  await page.locator('#note').fill('Woke up soaked');
  await page.locator('#note').blur();

  await page.locator('[data-act="end-flash"]').click();
  await page.locator('#endnote').fill('Passed after opening a window');
  await page.locator('[data-act="confirm-end"]').click();

  await expect(page.locator('.ribbon')).toHaveCount(0);
  const note = (await (await page.request.get('/api/flashes')).json()).flashes[0].note;
  expect(note).toContain('Woke up soaked');
  expect(note).toContain('Passed after opening a window');
});

test('history shows the day summary and the entry', async ({ page }) => {
  await page.locator('.slider').fill('7');
  await page.locator('[data-sym="chills"]').click();
  await page.locator('[data-act="begin"]').click();

  await page.locator('[data-tab="history"]').click();

  // Two strips now: flashes first, day check-ins under it.
  await expect(page.locator('.stats').first()).toContainText('1');
  await expect(page.locator('.entry').first()).toBeVisible();
  await expect(page.locator('.scroll')).toContainText(/chills/i);
});

/*
 * A duration written at 3am is a guess made half asleep, and the flash she
 * sleeps through has no duration at all until she is awake to say so. Tapping
 * the row reopens the same card it was closed with, so the record can be
 * corrected later rather than being wrong forever.
 */
test('tapping a history row reopens the end card and corrects the duration', async ({ page }) => {
  await page.locator('[data-act="begin"]').click();
  await page.locator('[data-act="end-flash"]').click();
  await page.locator('.slider.dur').fill('10');
  await page.locator('[data-act="confirm-end"]').click();
  await expect(page.locator('.ribbon')).toHaveCount(0);

  await page.locator('[data-tab="history"]').click();
  await expect(page.locator('.entry').first()).toContainText('10 min');

  await page.locator('.entry').first().click();

  // Editing, not ending: nothing is running, and the card says so.
  await expect(page.locator('.sheetbar')).toContainText('Editing this flash');
  // It arrives showing what is on the record rather than a fresh default.
  await expect(page.locator('.gauge .val')).toContainText('10');

  const confirm = page.locator('[data-act="confirm-end"]');
  await expect(confirm).toContainText(/Save · \d+ min/);
  await page.locator('.slider.dur').fill('35');
  await confirm.click();

  await expect(page.locator('.entry').first()).toContainText('35 min');
  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes[0].status).toBe('ended');
  expect(flashes[0].durationMin).toBe(35);
  // The end time is derived from the duration, so the two can never disagree.
  const span = (Date.parse(flashes[0].endedAt) - Date.parse(flashes[0].startedAt)) / 60_000;
  expect(Math.round(span)).toBe(35);
});

test('a flash slept through can be given a length later', async ({ page }) => {
  // The commonest flash of all: started hours ago, nobody awake to close it.
  await page.request.post('/api/flashes', {
    data: { startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() },
  });
  await page.reload();

  await page.locator('[data-act="end-flash"]').click();
  // Past an hour the timer is not evidence, so the card refuses to guess.
  await expect(page.locator('[data-act="confirm-end"]')).toContainText('Close without a duration');
  await page.locator('[data-act="confirm-end"]').click();

  await page.locator('[data-tab="history"]').click();
  await expect(page.locator('.entry').first()).toContainText('No end');

  await page.locator('.entry').first().click();
  await expect(page.locator('.sheetbar')).toContainText('Editing this flash');

  /*
   * Editing has no case to argue, so the slider is simply there — no warning
   * to read past first. It stays honest by not counting as an answer until she
   * moves it, so opening the row to fix a note cannot stamp a length on a flash
   * she slept through.
   */
  const slider = page.locator('.slider.dur');
  await expect(slider).toBeVisible();
  await expect(page.locator('[data-act="end-manual"]')).toHaveCount(0);
  await expect(page.locator('[data-act="confirm-end"]')).toContainText('Save with no duration');

  await slider.fill('22');
  await expect(page.locator('[data-act="confirm-end"]')).toContainText('Save · 22 min');
  await page.locator('[data-act="confirm-end"]').click();

  await expect(page.locator('.entry').first()).toContainText('22 min');
});

/*
 * A record with no length has to start the slider somewhere, and her own
 * average is better evidence than any number we could pick — it is also the
 * number she is most likely correcting towards. Read once when the sheet opens;
 * it is a benchmark, not a live reading.
 */
test('the slider starts from her own average when there is no length on record', async ({
  page,
}) => {
  for (const min of [10, 30]) {
    const f = await (
      await page.request.post('/api/flashes', {
        data: { startedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString() },
      })
    ).json();
    await page.request.post(`/api/flashes/${f.id}/end`, {
      data: { endedAt: new Date(Date.parse(f.startedAt) + min * 60_000).toISOString() },
    });
  }
  // ...and one with no length at all, which is the row being corrected.
  await page.request.post('/api/flashes', {
    data: { startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() },
  });
  await page.reload();
  await page.locator('[data-act="end-flash"]').click();
  await page.locator('[data-act="confirm-end"]').click();

  await page.locator('[data-tab="history"]').click();
  await page.locator('.entry').first().click();

  // The average of 10 and 30, not a number of ours.
  await expect(page.locator('.gauge .val')).toContainText('20');
});

/*
 * The closing note is the one thing here that is edited rather than appended
 * to — otherwise there is no way to fix something written half asleep.
 */
test('editing a finished flash replaces its note in place', async ({ page }) => {
  await page.locator('[data-act="begin"]').click();
  // No blur: tapping straight from the keyboard to End is the real gesture, and
  // the note must survive it.
  await page.locator('#note').fill('woke up soaked');
  await page.locator('[data-act="end-flash"]').click();
  await page.locator('[data-act="confirm-end"]').click();

  await page.locator('[data-tab="history"]').click();
  await page.locator('.entry').first().click();

  const note = page.locator('#endnote');
  await expect(note).toHaveValue('woke up soaked');
  await note.fill('woke up soaked — third night running');
  await page.locator('[data-act="confirm-end"]').click();

  const flashes = (await (await page.request.get('/api/flashes')).json()).flashes;
  expect(flashes[0].note).toBe('woke up soaked — third night running');
});

test('export offers both formats and the CSV downloads with real rows', async ({ page }) => {
  await page.locator('[data-act="begin"]').click();
  await page.locator('[data-tab="export"]').click();

  await expect(page.getByText('Flashes (CSV)')).toBeVisible();
  await expect(page.getByText('Day check-ins (CSV)')).toBeVisible();
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

test('tapping a symptom mid-flash does not throw the screen back to the top', async ({ page }) => {
  await page.locator('[data-act="begin"]').click();
  await expect(page.locator('.ribbon')).toBeVisible();
  // Measure only once the sync bar has cleared: it sits outside the scroller,
  // so it changes how far the scroller can travel and would race the check.
  await expect(page.locator('.sync-bar')).toHaveCount(0);

  const scroller = page.locator('.scroll');
  const chills = page.locator('[data-sym="chills"]');
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  // Clicking scrolls the target into view first, so settle that before reading
  // the baseline — otherwise the test measures its own scrolling, not the app's.
  await chills.scrollIntoViewIfNeeded();
  const before = await scroller.evaluate((el) => el.scrollTop);
  expect(
    before,
    'the log screen must actually be scrollable for this to mean anything',
  ).toBeGreaterThan(40);

  await chills.click();
  await expect(chills).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBe(before);
});
