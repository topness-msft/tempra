# Logging a flash from iOS

Tempra is a web app, but the fastest way to log a flash is never to open it. This
sets up two Shortcuts:

| Shortcut | Taps | When it's for |
| --- | --- | --- |
| **Log hot flash** | one, no prompts | 3am, half asleep, phone face-down on the nightstand |
| **Log hot flash with detail** | asks intensity, then a note | daytime, when there's attention to spare |

Build the one-tap version first. It is the one that will actually get used — a
shortcut that asks a question is a shortcut that doesn't get finished at 3am.

## What you need

Your API token: the value of the `TEMPRA_API_TOKEN` secret you set when you
deployed. Fly secrets are write-only, so `flyctl` can't read it back to you —
keep your own copy somewhere safe at the moment you set it. Below it's written
as `YOUR_API_TOKEN`.

Treat it like a password. Anyone holding it can read and write the whole log.

Note this is *not* the passphrase you type into the website. The app login and the
API token are separate credentials, and changing one doesn't affect the other.

Your app's address: your Fly app's hostname, `https://<your-app>.fly.dev`. Below
it's written as `https://your-app.fly.dev`.

---

## 1. "Log hot flash" — one tap, no questions

1. Open **Shortcuts** → **+** (top right).
2. Tap **Add Action**, search for **Get Contents of URL**, add it.
3. In the URL field type:
   ```
   https://your-app.fly.dev/api/flashes
   ```
4. Tap the **▸** next to the URL to expand the action, then set:
   - **Method**: `POST`
   - **Headers** → **Add new header**
     - Key: `Authorization`
     - Text: `Bearer YOUR_API_TOKEN` ← the word `Bearer`, one space, then the token
   - **Request Body**: `JSON`
5. Under Request Body tap **Add new field** → **Text**:
   - Key: `source`
   - Text: `shortcut`

   This is what makes the app show these entries as having come from the phone
   rather than from the website or the bedside button.
6. Rename the shortcut (tap its name at the top) to **Log hot flash**. This is the
   phrase Siri listens for, so keep it short and say it out loud once to check it
   doesn't collide with anything else on the phone.

Tap it once to test. It should say "Done" and nothing else. Open Tempra and the
flash should be at the top of the screen with a running timer. Delete that test
entry from the app afterwards.

### Silencing the confirmation banner

Settings → **Shortcuts** → **Advanced** → turn off *Show When Run*. At night, a
full-width banner is not what you want. Leave it on if the confirmation is
reassuring.

---

## 2. Putting it where a hand can find it in the dark

**Back Tap** — the best of the three at night, because it needs no aim:

Settings → **Accessibility** → **Touch** → **Back Tap** → **Double Tap** → scroll
to the bottom and pick **Log hot flash**. Two taps on the back of the phone, eyes
closed, phone still face-down.

**Lock Screen widget** — reachable without unlocking:

1. Long-press the Lock Screen → **Customise** → **Lock Screen**.
2. Tap the widget row under the clock → **Shortcuts** → pick the circular
   single-shortcut widget → choose **Log hot flash**.

**Home Screen icon** — behaves like an app icon:

In Shortcuts, long-press **Log hot flash** → **Share** → **Add to Home Screen**.

**Siri** — nothing to configure. Say *"Hey Siri, Log hot flash"*; the shortcut's
name is the phrase.

---

## 3. "Log hot flash with detail"

Long-press the first shortcut → **Duplicate**, rename it **Log hot flash with
detail**, then add two prompts *above* the Get Contents of URL action:

1. **Ask for Input** — Prompt: `How bad?`, Input Type: **Number**, Default: `5`
2. **Ask for Input** — Prompt: `Anything to note?`, Input Type: **Text**, and turn
   **on** *Allow Empty*

Then add two more Request Body fields to the URL action:

| Type | Key | Value |
| --- | --- | --- |
| Number | `intensity` | the **Provided Input** from the first Ask |
| Text | `note` | the **Provided Input** from the second Ask |

To insert those variables, tap the value field and pick **Provided Input** from
the bar above the keyboard. With two Asks you'll get two entries — they're listed
in the order the actions run.

Intensity must be a whole number from **1 to 10**; anything else comes back as a
400 and the shortcut shows a red error. The note is capped at 2000 characters.

Symptoms are deliberately not asked here. Tapping through nine symptom tiles is
what the app is for, and a shortcut asking nine questions is worse than just
opening it. Anything logged from a shortcut can be opened in Tempra later and
filled in — that's the intended workflow: capture now, annotate whenever.

---

## 4. Optional: guard against double-taps

Add a `clientId` and the server will treat a repeat as the same flash, returning
the original instead of creating a second one.

Above the Get Contents of URL action add:

1. **Current Date**
2. **Format Date** → Date Format: **Custom** → Format String: `yyyy-MM-dd-HH-mm`

Then one more Request Body field:

| Type | Key | Value |
| --- | --- | --- |
| Text | `clientId` | `shortcut-` followed by the **Formatted Date** variable |

Two taps in the same minute now log one flash. A genuine second flash within the
same minute would also be swallowed — the same trade the bedside button makes with
its 60-second debounce, and for the same reason: at 3am an accidental double-tap is
far more likely than two distinct flashes sixty seconds apart.

---

## 5. Ending a flash from a shortcut

Usually unnecessary. Most flashes are slept through and never get an end time,
which the app is built to accept — a flash with no end time is a complete record,
not a broken one.

If you want one anyway, duplicate the first shortcut and change only the URL to:

```
https://your-app.fly.dev/api/flashes/end
```

An empty JSON body means "it ended just now". Sending `{"endedAt": null}` closes it
with **no** end time and no duration, which is the honest answer when she wakes and
finds a flash that's been running since 2am.

---

## 6. Checking in on the day from a shortcut

Day check-ins are the symptoms that aren't episodes — tinnitus, brain fog, a bad
night. They're keyed on the date rather than on an event, so a shortcut writes to
a URL that names the day:

```
https://your-app.fly.dev/api/days/2026-07-26
```

Use **PATCH**, not PUT. PATCH folds the symptoms you name into whatever is already
recorded for that day; PUT replaces the whole check-in, so a Siri phrase that
mentions one symptom would wipe everything logged earlier that morning.

Build **Log tinnitus** as a duplicate of the first shortcut, then:

1. Add **Current Date**, then **Format Date** → **Custom** → Format String
   `yyyy-MM-dd`. This has to be the *phone's* date — the day is a local calendar
   day, not a UTC one, and at 1am those differ.
2. In **Get Contents of URL**, set the URL to
   `https://your-app.fly.dev/api/days/` followed by the **Formatted Date** variable.
3. **Method**: `PATCH`, same `Authorization` header, **Request Body**: `JSON`.
4. In the request body add one field:

   | Type | Key | Value |
   | --- | --- | --- |
   | Dictionary | `symptoms` | one entry — Key `tinnitus`, Type **Number**, Value `2` |

Severity is `0`–`3`: **0 None, 1 Mild, 2 Moderate, 3 Severe**. Send `null`
instead of a number to take a symptom back to unrecorded.

The symptom keys are `sleep`, `fatigue`, `brain_fog`, `low_mood`, `tinnitus`,
`joint_pain`, `anxiety`, `headache`, `dryness`, `skin`. Anything else is a 400.

To ask rather than assume, put a **Choose from Menu** above the request, prompt
`How bad?`, with three items: **Mild**, **Moderate**, **Severe**. In each branch
add a **Number** action (`1`, `2`, `3` respectively) followed by **Set Variable**
→ `severity`, then use that variable as the value in step 4.

Use a menu rather than **Ask for Input**, because this shortcut's whole point is
being run by voice. Ask for Input set to Number makes Siri ask you to *say a
number*, and nobody knows offhand whether their tinnitus is a 2 or a 3. A menu
is read aloud as its item names, so you answer "moderate" and mean it. Worth the
extra prompt here in a way it isn't for a flash, because a check-in is a daytime
action with attention to spare.

A note for the day works the same way: add a Text field with key `note`. It
replaces the day's existing note rather than appending, so keep it for shortcuts
that are the only thing writing one.

Nothing here is queued if you're offline — the same caveat as everything else in
this document. Use the app's **Day** tab, which writes to the outbox.

---

## Troubleshooting

| What you see | What it means |
| --- | --- |
| Red error, `401` | The `Authorization` header is wrong. Check it reads `Bearer ` then the token — one space, no line break, no smart quotes. |
| Red error, `400` `invalid_body` | Intensity isn't a whole number 1–10, or a body field was added as Text where it should be Number. |
| Nothing appears in the app | Pull to refresh. Then check the URL is `https://` with no trailing space. |
| Worked yesterday, not today | The API token was rotated. Update the header in both shortcuts. |
| `429` | Rate limited. You are fine; wait a minute. |

**No signal at 3am?** Log it in the **app** instead. The PWA queues writes offline
and syncs when signal returns. A shortcut posts straight to the server and has no
such queue, so it needs a connection. This is the one thing the app does that the
shortcut can't, and it's worth knowing before the night it matters.
