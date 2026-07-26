/**
 * Local persistence. The outbox is sacred: it holds writes the server has not
 * accepted yet, so it must survive anything. The cache is disposable and is
 * evicted first when storage runs out.
 */
const OUTBOX_KEY = 'tempra.outbox.v1';
const CACHE_KEY = 'tempra.cache.v1';
const GRAVE_KEY = 'tempra.deleted.v1';

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown): boolean => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Out of quota. Drop the disposable cache and retry once, so that a full
    // history never costs someone the flash they just logged.
    if (key === OUTBOX_KEY) {
      try {
        localStorage.removeItem(CACHE_KEY);
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
};

export type PendingOp =
  | { id: string; kind: 'start'; at: string; body: Record<string, unknown> }
  | { id: string; kind: 'end'; at: string; flashId: string | null; body: Record<string, unknown> }
  | { id: string; kind: 'update'; at: string; flashId: string; body: Record<string, unknown> }
  | { id: string; kind: 'delete'; at: string; flashId: string };

export const outbox = {
  all: (): PendingOp[] => read<PendingOp[]>(OUTBOX_KEY, []),
  add: (op: PendingOp): boolean => {
    const list = outbox.all();
    list.push(op);
    return write(OUTBOX_KEY, list);
  },
  remove: (id: string): void => {
    write(
      OUTBOX_KEY,
      outbox.all().filter((o) => o.id !== id),
    );
  },
  /** True when this id belongs to a start the server has not accepted yet. */
  isQueuedStart: (id: string | null): boolean =>
    id !== null && outbox.all().some((o) => o.kind === 'start' && o.id === id),
  /**
   * Folds a change into a queued start rather than queueing a separate edit.
   * Editing a flash that does not exist on the server yet is just a change to
   * what will be created; sending it as a PATCH would 404 and be discarded.
   */
  patchQueuedStart: (id: string, patch: Record<string, unknown>): boolean => {
    const list = outbox.all();
    const op = list.find((o) => o.kind === 'start' && o.id === id);
    if (!op || op.kind !== 'start') return false;
    op.body = { ...op.body, ...patch };
    write(OUTBOX_KEY, list);
    return true;
  },
  size: (): number => outbox.all().length,
};

export const cache = {
  get: <T>(fallback: T): T => read<T>(CACHE_KEY, fallback),
  set: (value: unknown): void => {
    write(CACHE_KEY, value);
  },
};

/**
 * Ids this device has deleted.
 *
 * The queued delete is not enough on its own. It leaves the outbox the instant
 * it succeeds, and a `/api/state` fetch that was already in flight can still be
 * carrying the flash — so between the two, nothing is subtracting it and the
 * row the user deleted comes back on screen. These headstones outlive that gap,
 * and are cleared only once the server's own view agrees the flash is gone.
 *
 * Persisted, because the gap can span a reload.
 */
export const grave = {
  all: (): string[] => read<string[]>(GRAVE_KEY, []),
  add: (id: string): void => {
    const list = grave.all();
    if (!list.includes(id)) write(GRAVE_KEY, [...list, id]);
  },
  forget: (ids: string[]): void => {
    if (ids.length === 0) return;
    const keep = grave.all().filter((id) => !ids.includes(id));
    write(GRAVE_KEY, keep);
  },
};
