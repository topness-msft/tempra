import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Compare without leaking length or content through timing. Any comparison of
 * a caller-supplied secret goes through here.
 */
export const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, so hash first to fix the length.
  const ah = createHmac('sha256', 'cmp').update(ab).digest();
  const bh = createHmac('sha256', 'cmp').update(bb).digest();
  return timingSafeEqual(ah, bh);
};

export const hashPassphrase = (passphrase: string, salt?: string): string => {
  const s = salt ?? randomBytes(16).toString('hex');
  const derived = scryptSync(passphrase, s, 32).toString('hex');
  return `scrypt$${s}$${derived}`;
};

export const verifyPassphrase = (passphrase: string, stored: string): boolean => {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = parts[1];
  const expected = parts[2];
  if (!salt || !expected) return false;
  const derived = scryptSync(passphrase, salt, 32).toString('hex');
  return safeEqual(derived, expected);
};

export const newSecret = (bytes = 16): string => randomBytes(bytes).toString('base64url');
