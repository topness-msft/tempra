# The bedside button (Hubitat)

A physical button on the nightstand. One press does two things at once:

1. tells the bed to start cooling, and
2. records that a flash has begun.

That's the whole point of it. She should be able to hit it in the dark, with her
eyes shut, and go back to sleep without ever picking up a phone.

## The one rule that matters

**A press always starts a flash. It is never a stop button.**

There is no "press again to end it". If a flash is already running when the button
is pressed, that flash becomes `superseded` — closed, with no end time and no
duration — and a new one starts.

This is deliberate, and it's worth understanding before you wire anything up. The
likeliest second press of any night is *another flash*, not someone wanting to
close the record of the first one. If a press were a toggle, that second press
would silently end the first flash and record nothing about the new one — losing
the worst hours of the worst nights, which are exactly the ones worth having.

So the trade is intentional: a superseded flash has no duration, because nobody
was awake to observe when it stopped, and the app would rather hold a gap than
invent a number.

## What you need

- A button device already paired (Lutron Aurora, Zooz ZEN34, SmartThings button —
  anything that fires a *pushed* event)
- Your bedside secret: the value of the `BEDSIDE_SECRET` Fly secret, in
  `.tmp/secrets.json` (gitignored). Written below as `YOUR_BEDSIDE_SECRET`.

The secret is the last segment of the URL rather than a header, because Rule
Machine's HTTP action can't attach headers. Which means **the URL itself is the
credential** — anyone who has it can log flashes. It's random and long, and the
endpoint returns a flat `404` for a wrong secret so it gives nothing away to
someone guessing, but don't paste it anywhere public.

## First: find Rule Machine

Where it lives depends on your platform version, and this is the single most
confusing part of the setup.

**Platform 2.4.x and newer** (redesigned UI, breadcrumb navigation, green buttons):
Rule Machine is in the **Automations** section of the left sidebar. It's already
there — nothing to install.

**Older platforms:** it's under **Apps**. If it isn't listed, add it with
**Apps** → **Add Built-In App** → **Rule Machine**.

On 2.4.x, Rule Machine appears in **neither** the Apps list **nor** the Add
Built-In App list, because it no longer lives under Apps at all. That looks
exactly like "not installed and not available", which sends you hunting for a
download that doesn't exist. Check the sidebar for **Automations** before
concluding anything is missing.

Everything below starts from **Automations** → **Rule Machine** →
**Create New Rule** (or **Apps** → **Rule Machine** on older platforms).

---

## Rule 1 — the button

**Automations** → **Rule Machine** → **Create New Rule**.

- **Name**: `Hot flash — bedside button`

### Setting the trigger

Rule Machine asks for a *capability* before it will show you any devices, which is
the step that trips people up — your button won't be in the device list until you
tell it you're looking for a button.

1. Next to **Trigger Events**, tap **Click to set**.
2. **Select capability for new Event Trigger** → choose **Button**.
3. **Button Device** → pick your button.
4. **Button number** → `1` (or whichever the device reports; see below).
5. Event type → **pushed**.
6. Tap **Done with this Trigger Event**.

If your button isn't in the device list at step 3, its driver doesn't expose the
button capability. Open the device in **Devices**, check the **Type** is a button
driver rather than a generic one, and hit **Configure**.

Not sure which button number a press sends? Open the device page, then the hub's
**Logs** in a second tab, and press it. The event shows the number.

### Setting the actions

Under **Actions to Run**, tap **Click to set**, then pick from the **Select Action
to Add** dropdown. It's a long list — the HTTP action is worded
**"Send HTTP Request..."**, not "HTTP Request" or "POST", which is why it's easy to
scroll past.

Add these in order:

1. Whatever cools the bed. Set the ChiliPad / BedJet / Ooler / cooling fan to its
   overnight setting. Put this **first** — it's the part she can feel, and it
   should not wait on a web request.

2. **Send HTTP Request...**:
   - Method / Action: **POST**
   - URL:
     ```
     https://tempra.fly.dev/hooks/bedside/YOUR_BEDSIDE_SECRET
     ```
   - Content type: **application/json**
   - Body:
     ```json
     {"kind":"press"}
     ```

   The body is optional — an empty POST is treated as a press — but sending it
   explicitly means the log says what happened rather than relying on a default.

   If there's no content type field, your hub firmware predates it. Update the
   platform; older Rule Machine builds sent everything as form-encoded, which this
   endpoint won't parse as JSON.

3. Optional: a very brief LED or dim-light acknowledgement, so a press that did
   nothing is distinguishable from a press that worked. Keep it under a second and
   keep it dim; the goal is going back to sleep.

Deliberately **not** here: any rule that turns the cooling back off after N
minutes, or that presses anything when the flash "ends". There is no end event.
Cool the bed on whatever schedule suits the night and let Tempra worry about the
record.

### Double-taps are already handled

Two presses within **60 seconds** log one flash. The second returns
`{"action":"debounced"}` and changes nothing. A button pressed in the dark gets
double-tapped, and Hubitat itself retries failed requests — neither should show up
as two flashes a minute apart. You don't need to build any debounce in Rule
Machine.

---

## Rule 2 — the heartbeat (optional, recommended)

Without this, Tempra can't tell "no flashes last night" from "the integration has
been broken for a week". Both look like silence, and only one of them is good news.

**Automations** → **Rule Machine** → **Create New Rule**:

- **Name**: `Hot flash — bedside heartbeat`
- **Trigger Events**: **Click to set** → capability **Certain Time** → **Periodic**
  → every hour
- **Actions to Run**: **Send HTTP Request...**
  - Method: **POST**
  - URL: the same `https://tempra.fly.dev/hooks/bedside/YOUR_BEDSIDE_SECRET`
  - Content type: **application/json**
  - Body:
    ```json
    {"kind":"heartbeat"}
    ```

A heartbeat only records that the hub can reach the server. It never starts,
changes, or ends a flash.

Tempra shows the bedside button as healthy while a heartbeat has arrived within
the last **3 hours**, so hourly gives you two misses of slack before it complains.
Adjust with the `BEDSIDE_HEARTBEAT_HOURS` secret if you change the interval.

---

## Testing it

1. Press the button.
2. The bed should start cooling.
3. Open Tempra — a flash should be running, and its source should show as the
   bedside button rather than the app.
4. Press again straight away. Nothing should change: that's the debounce.
5. Wait a minute and press again. The first flash should now show as superseded
   with no duration, and a new one should be running.
6. Delete the test flashes from the app.

To test without leaving the desk:

```bash
curl -X POST https://tempra.fly.dev/hooks/bedside/YOUR_BEDSIDE_SECRET \
  -H 'Content-Type: application/json' \
  -d '{"kind":"press"}'
```

A press returns `{"ok":true,"kind":"press","action":"started","flash":{...}}`.

---

## Troubleshooting

| What you see | What it means |
| --- | --- |
| Can't find Rule Machine at all | On platform 2.4.x it's under **Automations** in the sidebar, not Apps — and it won't appear in the Add Built-In App list either. Nothing is missing. |
| Can't find the HTTP action | It's worded **"Send HTTP Request..."** in the Select Action to Add list, not "HTTP Request" or "POST". |
| Button isn't in the device list | You skipped the capability picker — choose **Button** first. If it's still missing, the device's driver doesn't expose the button capability. |
| No content type field | Hub firmware is too old. Update the platform, or the body goes out form-encoded and won't parse as JSON. |
| `404` | Wrong secret, or a typo in the URL. The endpoint returns 404 rather than 401 so that probing it tells an attacker nothing. |
| `429` | Rate limited — you're testing faster than a human presses buttons. Wait a minute. |
| `{"action":"debounced"}` | Working as designed. Under 60s since the last press. |
| Bed cools, nothing logged | The HTTP Request action is failing. Check Hubitat's **Logs** for the rule; usually the URL or the content type. |
| Logged, bed doesn't cool | The cooling action is failing, and it's ordered first for exactly this reason — the two are independent. Test that device on its own. |
| App says the button is stale | No heartbeat in 3 hours. Check the hub is online and Rule 2 is enabled. |

---

## What Hubitat can't do

It can't log symptoms, intensity, or a note. It's one button and it means one
thing: *this is happening now*. Everything else gets filled in later, from the app,
in daylight — open the flash from the history and add whatever's remembered.

That's the intended division of labour. The button captures the fact at the moment
it happens, which is the part that can't be reconstructed afterwards. Detail is
optional and can wait.
