<img src="packages/web/public/icon-192.png" alt="" width="104" align="right" />

# Tempra

A hot flash tracker. Single user, mobile first, and built around one assumption:
the moment worth capturing happens at 3am, in the dark, on a phone with one bar,
by someone who wants to go back to sleep.

Live at **https://tempra.fly.dev**.

## What it does

- **Log a flash in one tap** — from the app, an iOS Shortcut, Siri, or a physical
  button on the nightstand that also starts the bed cooling.
- **Works offline.** The web app is a PWA that queues writes locally and syncs when
  signal returns. Offline isn't a nicety here; it's the primary case.
- **Add detail whenever.** Intensity, nine symptoms, a free note, and a finger
  sketch. All optional, all editable later.
- **Delete a mistake** by swiping an entry in history — with a few seconds to undo,
  before anything actually leaves the device.
- **Export everything** as CSV or JSON, so the data can go to a doctor, a
  spreadsheet, or somewhere else entirely. It is her data.

### A flash doesn't need an end time

The commonest flash is the one slept through. The bed cools, she settles, and
nobody is awake to close the record. Tempra treats that as a complete entry, not a
broken one — a flash can end with no end time and no duration, and it never
invents one to fill the gap.

The same principle runs through the whole app. Recording *that a flash happened*
is the point. Everything else is detail that may never arrive, and a record with a
gap in it beats a record with a guess in it.

### Deleting is deferred, not undone

Swiping only *reveals* the delete button; a full swipe never commits on its own.
This is a list being scrolled one-handed in the dark, where a sideways wobble is
routine, so destroying a record always takes a second, aimed tap.

Even then nothing is sent immediately. The row disappears, the delete is held for
a few seconds, and only when that window closes does the request go out. Undo is
therefore a real cancellation rather than a re-creation — restoring a deleted
flash by logging it again would give it a new identity and, because starting a
flash supersedes the running one, could quietly close whatever is happening now.

Once the window closes the id is written to a small persistent tombstone list.
The queued delete alone is not enough to keep the row off screen: it leaves the
outbox the instant it succeeds, and a `/api/state` response that was already in
flight can still be carrying the flash — so without the tombstone the record
reappears seconds after being deleted. Tombstones are cleared as soon as the
server's own view agrees the flash is gone.

## Setup guides

- [Logging a flash from iOS](docs/ios-shortcut.md) — Shortcuts, Siri, Lock Screen
  widget, and Back Tap
- [The bedside button](docs/hubitat-bedside.md) — Hubitat Rule Machine, bed cooling,
  and why a press is never a stop button

## The icon

<img src="packages/web/public/icon-192.png" alt="The Tempra icon: a leaning flame knocked out of a berry disc, ringed in gold" width="72" align="left" hspace="16" vspace="4" />

A leaning flame knocked out of a berry disc, ringed in gold. The inversion is the
whole trick — a flame drawn *inside* a ring is three shapes competing for 32
pixels and it collapses into mush, while a knockout is two shapes and survives.
The flame's asymmetry is load-bearing too: the symmetric version of this
silhouette reads unmistakably as a water droplet.

<br clear="left" />

At 16px the gold ring is finer than a device pixel and turns to a muddy halo, so
the smallest favicon frame drops it. That is the only difference between the two
variants in the set.

Every size comes from one vector source:

```bash
node ops/make-icons.mjs
```

which writes `favicon.svg`, a three-frame `favicon.ico` (16/32/48), the Apple
touch icon, and the manifest PNGs including a separate maskable cut whose content
sits inside Android's 80% safe circle. Nothing in `packages/web/public/` is
hand-edited; regenerate instead. `design/icon-*.html` holds the three rounds of
candidates at real sizes, kept as the record of why this one won.

## Development

Requires Node 22.11+.

```bash
npm install
npm run dev          # server on :8080, serving the built web app
npm test             # unit tests (vitest)
npm run e2e          # end-to-end tests (playwright)
npm run typecheck
npm run build
```

`@tempra/shared` resolves through its `dist/`, so after changing a schema you need
`npm run build -w @tempra/shared` before the server tests will see it. Skipping
this produces a confusing 400 rather than a type error.

### Layout

```
packages/shared   zod schemas and the symptom vocabulary — the contract
packages/server   fastify + sqlite (better-sqlite3), all invariants in the schema
packages/web      the PWA: vanilla TS, no framework, service worker, outbox
e2e               playwright specs
ops               litestream config and the container entrypoint
```

Two files carry more weight than the rest:

- **`packages/server/src/db.ts`** holds the schema, both migrations, and the
  foreign-key handling around them. Migration 2 rebuilds the `flashes` table, and
  dropping that table with foreign keys enabled would cascade-delete the very rows
  the rebuild exists to preserve. The pragma juggling is load-bearing.
- **`packages/web/src/api.ts`** — `projectState()` replays the offline outbox over
  server state. It's the single point where offline correctness is decided.

## Deployment

Fly.io, single machine in `iad`, SQLite on a mounted volume.

```bash
flyctl deploy
```

The machine does not auto-stop. A cold start behind a suspended machine is the one
failure that would actually be felt at 3am, so it stays warm.

### Backups

Litestream streams the SQLite database to Tigris object storage on a 60-second
interval, so worst-case loss is a minute. The container entrypoint restores
automatically when it finds no local database, which covers volume loss and fresh
machines.

This has been verified by drill, not by reading logs: a marker flash was written,
given a minute to replicate, then the database, WAL, and shadow directory were
moved off the volume and the machine restarted. The entrypoint restored from
Tigris and the marker was still there.

### Configuration

| Secret | Purpose |
| --- | --- |
| `TEMPRA_PASSPHRASE` | The passphrase for the website login |
| `TEMPRA_API_TOKEN` | Bearer token for the iOS Shortcut |
| `BEDSIDE_SECRET` | Last path segment of the bedside webhook URL |
| `SESSION_SECRET` | Signs the session cookie |
| `BUCKET_NAME`, `AWS_*` | Tigris credentials for Litestream |
| `BEDSIDE_HEARTBEAT_HOURS` | Silence before the bedside button counts as stale (default 3) |

The app login and the API token are independent — rotating one doesn't affect the
other. Rotating `SESSION_SECRET` logs every device out.

If `TEMPRA_PASSPHRASE` is unset the API is unauthenticated and the server says so
loudly at boot. Don't run it that way anywhere reachable.

> **`fly storage create` does not reliably inject its own secrets.** It writes
> them to the app's secret store, where `flyctl secrets list` cheerfully reports
> them as Deployed, but the machine may never receive them — and neither a
> restart nor a redeploy fixes it. Litestream then starts without a replica and
> says nothing, because backing up nowhere looks exactly like backing up. If
> backups appear silent, check the names inside the machine
> (`flyctl ssh console -C printenv`) rather than trusting `secrets list`, and
> re-set them by hand with `flyctl secrets set`.
