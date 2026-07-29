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
- Your bedside secret: the value of the `BEDSIDE_SECRET` Fly secret you set when
  you deployed. Fly can't read it back to you, so keep your own copy at the time
  you set it. Written below as `YOUR_BEDSIDE_SECRET`.
- Your app's address: your Fly app's hostname. Written below as
  `https://your-app.fly.dev`.

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

#### If the button lives in Apple Home, not on the hub

A HomeKit button never reaches Hubitat as a button. It reaches an integration —
HomeKit Bridge, Homebridge — which calls `on()` on a **virtual switch**. There is
no button device to pick, and the trigger has to watch that switch instead.

Choose capability **Switch**, the virtual switch, and state **on**.

**Do not choose "Physical Switch".** It is the more precise-sounding option and it
will silently never fire. Rule Machine subscribes it to the same `switch.on` event
but routes it through a handler that first checks `evt.type == "physical"`. An
integration calling `on()` produces a *digital* event with no type set, so the
handler returns without running a single action.

Nothing about this looks like a failure. The hub's event list still shows the rule
under **Triggered apps**, because the handler genuinely was invoked — it just
declined to do anything. The bed cools, because that's a separate action on a
separate device. The only visible symptom is that Tempra stays empty.

**After changing a trigger, open the rule and tap Done.** Rule Machine only
rebuilds its event subscriptions inside `updated()`, which nothing but leaving the
rule triggers. Change the capability and walk away and the settings will show your
new trigger while the hub is still subscribed via the old handler. Confirm it took
on **Settings** → **Apps** → your rule → the app status page: under **Event
Subscriptions** the handler should read `allHandlerX`, not `physicalHandler`.

One consequence worth accepting deliberately: a plain Switch trigger fires whenever
*anything* turns that switch on, including your own schedules and other
automations. If the switch is shared, those presses-that-weren't get logged as
flashes. Either accept it, or give the button a virtual switch of its own that
nothing else touches.

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
     https://your-app.fly.dev/hooks/bedside/YOUR_BEDSIDE_SECRET
     ```
   - Content type: **application/json**
   - Body:
     ```json
     {"kind":"press"}
     ```

   The body is optional — an empty POST is treated as a press — but sending it
   explicitly means the log says what happened rather than relying on a default.

   If there's no content type field, your hub firmware predates it and the body
   goes out form-encoded. That is fine; the endpoint accepts form-encoded, an empty
   body, and a JSON body mislabelled `text/plain`, precisely because none of this
   is configurable from the rule. You do not need to update the platform for this.

   Type the body carefully. `kind` must be exactly `press` or `heartbeat` (case
   and surrounding spaces don't matter, but the spelling does), and no other
   keys are allowed. Anything else gets a `400` rather than being read as a
   press — a typo in the *heartbeat* rule would otherwise log a hot flash every
   hour, forever, and nothing would tell you.

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

The same applies across paths: a press within 60 seconds of a flash logged by
Siri is treated as the same flash, and so is a Siri request within 60 seconds of
a press. Not being able to tell whether the first thing worked is exactly why
you'd reach for the second, so the two shouldn't add up to two flashes. The bed
still cools either way — that's a separate hub action that never sees this
response.

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
  - URL: the same `https://your-app.fly.dev/hooks/bedside/YOUR_BEDSIDE_SECRET`
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
curl -X POST https://your-app.fly.dev/hooks/bedside/YOUR_BEDSIDE_SECRET \
  -H 'Content-Type: application/json' \
  -d '{"kind":"press"}'
```

A press returns `{"ok":true,"kind":"press","action":"started","flash":{...}}`.

To check the URL and secret **without** logging anything, open it in a browser, or:

```bash
curl -i https://your-app.fly.dev/hooks/bedside/YOUR_BEDSIDE_SECRET
```

A GET never records a press. If the secret is right you get `405` and a hint
saying so; if it's wrong you get the same `404` as any unknown path. That
asymmetry is deliberate — pasting the URL into a browser is the first thing
anyone tries, and it used to answer `{"error":"not_found"}` whether or not
anything was wrong, which reads as a broken hook and sends you looking in the
wrong place. Telling the truth here gives nothing away: this URL *is* the
credential, so anyone who can make the request could already start a flash.

---

## Troubleshooting

| What you see | What it means |
| --- | --- |
| Can't find Rule Machine at all | On platform 2.4.x it's under **Automations** in the sidebar, not Apps — and it won't appear in the Add Built-In App list either. Nothing is missing. |
| Can't find the HTTP action | It's worded **"Send HTTP Request..."** in the Select Action to Add list, not "HTTP Request" or "POST". |
| Button isn't in the device list | You skipped the capability picker — choose **Button** first. If it's still missing, the device's driver doesn't expose the button capability. A HomeKit button will never appear: it arrives as a virtual switch. |
| No content type field | Hub firmware predates it, so the body goes out form-encoded. Harmless — the endpoint accepts that. |
| Opening the URL in a browser | A browser sends GET and this endpoint only answers POST. A correct secret returns `405` with a hint, so this is a usable check; a wrong one returns `404`. |
| `404` | Wrong secret, or a typo in the URL. A wrong secret returns 404 rather than 401 so that probing it tells an attacker nothing. |
| `429` | Rate limited — you're testing faster than a human presses buttons. Wait a minute. |
| `400` with `invalid_body` | The body has a typo — a misspelled key, or a `kind` that isn't `press` or `heartbeat`. It fails loudly on purpose: reading an unrecognised body as a press would fabricate a flash out of a typo. |
| `{"action":"debounced"}` | Working as designed. Under 60s since the last flash — from a press, or from Siri. |
| Bed cools, nothing logged | The rule never got as far as the HTTP action. Check the hub's **Logs** for the rule: a working press logs three lines — `Event:`, `Triggered:`, `Action: Send POST to:`. No lines at all means the trigger dropped the event, most often a **Physical Switch** trigger fed by a HomeKit integration. See *If the button lives in Apple Home*. |
| Rule appears under "Triggered apps" but does nothing | Same cause. That column records that the handler was called, not that it acted, so a Physical Switch trigger discarding a digital event still shows up there. |
| Trigger looks right but still nothing | Subscriptions are only rebuilt when the rule is left via **Done**. Check the app status page: **Event Subscriptions** should show `allHandlerX`, not `physicalHandler`. |
| Presses log the first time then stop | A virtual switch only emits `on` when it changes. Press while it's already on and the hub records `command-on` with no event, so nothing triggers. Give the button its own switch with auto-off if you need every press. |
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
