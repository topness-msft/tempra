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

## Setup guides

- [Logging a flash from iOS](docs/ios-shortcut.md) — Shortcuts, Siri, Lock Screen
  widget, and Back Tap
- [The bedside button](docs/hubitat-bedside.md) — Hubitat Rule Machine, bed cooling,
  and why a press is never a stop button

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
| `BUCKET_NAME`, `AWS_*` | Tigris credentials; set by `fly storage create` |

The app login and the API token are independent — rotating one doesn't affect the
other. Rotating `SESSION_SECRET` logs every device out.

If `TEMPRA_PASSPHRASE` is unset the API is unauthenticated and the server says so
loudly at boot. Don't run it that way anywhere reachable.
