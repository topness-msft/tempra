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

### Confirming it landed

The 3am question isn't "did it work", it's *"do I tap again?"* — and tapping
again logs a phantom flash. Three actions answer it, and they're worth adding
together because each one surfaces in the context the others miss:

1. **Vibrate Device** — a buzz you feel. This is the one that matters for Back
   Tap and the widget, where nothing else has made a sound or shown a light. It
   also survives *Show When Run* being off.
2. **Show Content** — text `Flash logged, [Current Date].` Siri **speaks** this
   when the shortcut was invoked by voice, and shows a brief overlay when it was
   tapped. Worth having precisely because she has already spoken out loud to
   trigger it; a spoken reply adds nothing to a room that just heard her.

   Called **Show Result** before iOS 18, and still that in most guides you'll
   find online. If your action list has neither, search the chooser for
   "content" rather than scrolling.
3. **Show Notification** — the only one that *persists*. Show Content vanishes,
   so at 7am there is no record of what happened at 3am other than the app
   itself. A notification is still sitting there.

   **Turn off its Play Sound toggle.** Notifications chime by default, which is
   a sound in a dark room at exactly the hour this shortcut exists for. Silent,
   it still lands in Notification Center.

Put them in that order, last in the shortcut.

These three do not talk over each other. Siri's spoken reply is reserved for the
shortcut's *result*, so only Show Content is voiced; the notification stays
visual even with AirPods in, because Announce Notifications does not cover
Shortcuts-generated notifications. You get the line spoken once and a silent
copy that keeps.

For the voice path at night, don't build a second silent shortcut — iOS already
has the control. Settings → **Siri & Search** → **Siri Responses** → turn on
*Prefer Silent Responses*, and Siri shows text instead of speaking whenever the
ring switch is silenced. The phone being on silent overnight then handles it
without you maintaining two shortcuts that can drift apart.

Two actions to avoid here: **Show Alert** blocks until dismissed, which destroys
the one-tap property and stalls Siri mid-conversation; **Speak Text** always
talks, including when she tapped the widget at 3am rather than speaking.

### Silencing the confirmation banner

Settings → **Shortcuts** → **Advanced** → turn off *Show When Run*. At night, a
full-width banner is not what you want. Leave it on if the confirmation is
reassuring.

Note this only silences shortcuts that ask nothing. Anything containing Show
Result, Choose from Menu or Ask for Input needs the screen and will surface
regardless — which is why the plain **Log hot flash** can run invisibly and the
detail version in section 3 cannot.

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

## 7. Making the symptom shortcuts work by voice

The app is the primary way to record symptoms. Voice exists for the moment when
noticing and opening the app are two different amounts of effort — you register
that your ears have been ringing all morning while your hands are full.

**The shortcut's name is the sentence.** Siri has no understanding of this app;
it matches what you say against shortcut *titles*. So a shortcut named `Log
tinnitus` is what makes "Hey Siri, log tinnitus" a sentence Siri can act on.
Naming it `Tinnitus check-in` means you have to say *that* instead.

That single fact decides the whole design: **build one shortcut per symptom**,
named `Log <symptom>`, and only for the two or three that actually recur. All
ten is a chore that earns nothing — the rest belong to the Day tab.

The interaction is then two utterances:

```
You    Hey Siri, log tinnitus.
Siri   How bad? Mild, moderate, or severe.
You    Moderate.
Siri   Logged tinnitus — moderate — for today.
```

To get that spoken confirmation, end the shortcut with **Show Content** and text
along the lines of `Logged tinnitus — [severity] — for today.` Run hands-free
Siri reads it aloud; run from the Home Screen it's a banner. Without it you get
Siri's flat "Done", which tells you a shortcut ran but not what was written.

### Two builds to avoid, and why

**A single "Log symptom" shortcut that asks which one.** It's the obvious
economy — one shortcut instead of three — and it's the wrong shape for voice.
Choose from Menu is read *aloud*, so Siri recites all ten symptoms, eight to ten
seconds, before you can answer. A menu is nearly free on a screen and expensive
in the ear. If you want this build anyway, put it on the Home Screen widget
where the menu is a tap rather than a recital.

**Dictating the symptom name via Ask for Input → Text.** It sounds like the
natural fix for the recital problem, and dictation is the thing that fails:
"tinnitus" comes back as "tinnitis" or "tenetis" often enough that you'd need an
If/else chain per spelling, and you find out it failed only when the day looks
empty later. A menu can only return words Siri already has. Constraining the
vocabulary is the point.

### Saying it twice is safe

A check-in is keyed on the date and written with PATCH, so repeating the phrase
corrects the answer rather than logging a second one. Say "log tinnitus" and
answer *mild*, then reconsider an hour later and answer *severe*, and the day
holds severe — with everything else recorded that day untouched.

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
