const OFFSET_RE = /(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Minutes east of UTC encoded in an ISO-8601 string. `Z` is zero. */
export const offsetMinutesOf = (iso: string): number => {
  const m = OFFSET_RE.exec(iso);
  if (!m || m[1] === undefined) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
};

/** Canonical UTC form, used for storage so that values sort lexically. */
export const toUtcIso = (iso: string): string => new Date(iso).toISOString();

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Rebuild the local wall-clock representation from a UTC instant and the
 * offset that was in force. This is what makes a 3am entry still read as 3am.
 */
export const toLocalIso = (utcIso: string, offsetMin: number): string => {
  const shifted = new Date(Date.parse(utcIso) + offsetMin * 60_000);
  const base = shifted.toISOString().slice(0, -1);
  if (offsetMin === 0) return `${base}Z`;
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${base}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};
