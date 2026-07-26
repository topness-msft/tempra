import type { Flash } from '@tempra/shared';
import { durationMinutes } from '@tempra/shared';
import { outbox, cache, type PendingOp } from './storage.js';

/** A flash that may not have reached the server yet. */
export type PendingFlash = Flash & { pending?: boolean };

export interface BedsideStatus {
  lastPressAt: string | null;
  lastHeartbeatAt: string | null;
  health: 'unknown' | 'ok' | 'stale';
}

export interface AppState {
  active: PendingFlash | null;
  recent: PendingFlash[];
  bedside: BedsideStatus;
  insecure: boolean;
  commit: string;
}

const EMPTY: AppState = {
  active: null,
  recent: [],
  bedside: { lastPressAt: null, lastHeartbeatAt: null, health: 'unknown' },
  insecure: false,
  commit: 'dev',
};

export class Unauthorized extends Error {}

const request = async (url: string, init?: RequestInit): Promise<Response> => {
  const res = await fetch(url, {
    ...init,
    headers: {
      // Only declare a JSON body when there is one. Announcing JSON on a
      // bodyless request (DELETE, GET) makes Fastify reject it as an empty JSON
      // body with a 400 — and flushOne reads any 4xx as "the server will never
      // accept this", so the queued operation is dropped without a trace. That
      // is how deleting a flash silently did nothing.
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new Unauthorized('unauthorized');
  return res;
};

export const login = async (passphrase: string): Promise<boolean> => {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  return res.ok;
};

export const logout = async (): Promise<void> => {
  await fetch('/api/session', { method: 'DELETE' });
};

export const fetchState = async (): Promise<AppState> => {
  const res = await request('/api/state');
  if (!res.ok) throw new Error(`state ${res.status}`);
  const state = (await res.json()) as AppState;
  cache.set(state);
  return state;
};

export const cachedState = (): AppState => cache.get<AppState>(EMPTY);

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * Every mutation is written to the outbox first and only then attempted. If the
 * attempt fails the entry stays queued; if it succeeds it is removed. This is
 * what lets a flash logged with no signal survive a closed tab.
 */
const enqueue = async (op: PendingOp): Promise<boolean> => {
  outbox.add(op);
  return flushOne(op);
};

const flushOne = async (op: PendingOp): Promise<boolean> => {
  try {
    let res: Response;
    switch (op.kind) {
      case 'start':
        res = await request('/api/flashes', { method: 'POST', body: JSON.stringify(op.body) });
        break;
      case 'end':
        res = await request(
          op.flashId ? `/api/flashes/${op.flashId}/end` : '/api/flashes/end',
          { method: 'POST', body: JSON.stringify(op.body) },
        );
        break;
      case 'update':
        res = await request(`/api/flashes/${op.flashId}`, {
          method: 'PATCH',
          body: JSON.stringify(op.body),
        });
        break;
      case 'delete':
        res = await request(`/api/flashes/${op.flashId}`, { method: 'DELETE' });
        break;
    }
    // A 4xx other than 401 means the server will never accept this operation.
    // Keeping it would block the queue forever, so drop it.
    if (res.ok || (res.status >= 400 && res.status < 500)) {
      outbox.remove(op.id);
      return res.ok;
    }
    return false;
  } catch {
    return false;
  }
};

/** Replay queued writes oldest-first, stopping at the first failure. */
export const flushOutbox = async (): Promise<number> => {
  let sent = 0;
  for (const op of outbox.all()) {
    const ok = await flushOne(op);
    if (!ok && outbox.all().some((o) => o.id === op.id)) break;
    if (ok) sent += 1;
  }
  return sent;
};

export const pendingCount = (): number => outbox.size();

/**
 * The UI must never show the server's view alone. A flash logged with no signal
 * lives only in the outbox, and if the screen still says "nothing running" the
 * user reasonably concludes it did not save — and logs it again, or stops
 * trusting the app. So the rendered state is always the last known server state
 * with the queued writes replayed on top.
 *
 * Optimistic rows are marked `pending` so the UI can show them as not-yet-synced
 * rather than passing them off as confirmed.
 */
export const projectState = (base: AppState): AppState => {
  const ops = outbox.all();
  if (ops.length === 0) return base;

  let active: PendingFlash | null = base.active;
  let recent: PendingFlash[] = [...base.recent];

  const retire = (flash: PendingFlash, status: Flash['status'], endedAt: string | null) => {
    const closed: PendingFlash = {
      ...flash,
      status,
      endedAt,
      // Only a deliberate end produces a duration; supersession never does.
      durationMin:
        status === 'ended' && endedAt ? durationMinutes(flash.startedAt, endedAt) : null,
    };
    recent = [closed, ...recent.filter((f) => f.id !== flash.id)];
  };

  for (const op of ops) {
    switch (op.kind) {
      case 'start': {
        if (active) retire(active, 'superseded', null);
        const body = op.body as Record<string, unknown>;
        active = {
          id: op.id,
          startedAt: (body.startedAt as string) ?? op.at,
          endedAt: null,
          durationMin: null,
          intensity: (body.intensity as number | null) ?? null,
          symptoms: (body.symptoms as Flash['symptoms']) ?? [],
          note: (body.note as string | null) ?? null,
          sketch: (body.sketch as Flash['sketch']) ?? null,
          status: 'active',
          source: (body.source as Flash['source']) ?? 'app',
          createdAt: op.at,
          updatedAt: op.at,
          pending: true,
        };
        break;
      }
      case 'end': {
        const target = op.flashId
          ? (active?.id === op.flashId ? active : recent.find((f) => f.id === op.flashId)) ?? null
          : active;
        if (!target) break;
        const body = (op.body ?? {}) as Record<string, unknown>;
        // An explicit null means "over, but when it stopped is unknowable". It
        // must not fall back to the queue timestamp the way an omitted field
        // does, or replaying the outbox would invent a duration.
        const endedAt = 'endedAt' in body ? (body.endedAt as string | null) : op.at;
        retire({ ...target, pending: true }, 'ended', endedAt);
        if (active && target.id === active.id) active = null;
        break;
      }
      case 'update': {
        const patch = op.body as Partial<Flash>;
        if (active?.id === op.flashId) {
          active = { ...active, ...patch, pending: true };
        } else {
          recent = recent.map((f) => (f.id === op.flashId ? { ...f, ...patch, pending: true } : f));
        }
        break;
      }
      case 'delete': {
        if (active?.id === op.flashId) active = null;
        recent = recent.filter((f) => f.id !== op.flashId);
        break;
      }
    }
  }

  return { ...base, active, recent };
};

export const startFlash = async (body: Record<string, unknown>): Promise<boolean> =>
  enqueue({
    id: newId(),
    kind: 'start',
    at: new Date().toISOString(),
    // clientId makes the retry safe: a replayed start cannot create a second
    // flash for the same tap.
    body: { ...body, clientId: newId() },
  });

/**
 * A flash logged offline has only a client-side id. Addressing the server by
 * that id would 404, and a 4xx is dropped from the queue — silently losing the
 * end the user deliberately recorded. Because the outbox replays in order, the
 * queued start runs immediately before this end, so "end whatever is active" is
 * both correct and the only thing the server can act on.
 */
export const endFlash = async (
  flashId: string | null,
  body: Record<string, unknown>,
): Promise<boolean> =>
  enqueue({
    id: newId(),
    kind: 'end',
    at: new Date().toISOString(),
    flashId: outbox.isQueuedStart(flashId) ? null : flashId,
    body,
  });

export const updateFlash = async (
  flashId: string,
  body: Record<string, unknown>,
): Promise<boolean> => {
  // Editing a flash that has not been created yet is a change to what will be
  // created, not a separate PATCH.
  if (outbox.patchQueuedStart(flashId, body)) return false;
  return enqueue({ id: newId(), kind: 'update', at: new Date().toISOString(), flashId, body });
};

export const deleteFlash = async (flashId: string): Promise<boolean> => {
  // Deleting something the server never received just means forgetting it.
  if (outbox.isQueuedStart(flashId)) {
    outbox.remove(flashId);
    return true;
  }
  return enqueue({ id: newId(), kind: 'delete', at: new Date().toISOString(), flashId });
};

export const fetchHistory = async (limit = 200): Promise<Flash[]> => {
  const res = await request(`/api/flashes?limit=${limit}`);
  if (!res.ok) throw new Error(`history ${res.status}`);
  return ((await res.json()) as { flashes: Flash[] }).flashes;
};
