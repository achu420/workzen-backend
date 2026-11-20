// One-time e-mail codes for password recovery and passwordless sign-in.
//
// A code is 6 digits, valid for 10 minutes, accepted once, and dies after 5 wrong guesses. Only a salted hash is kept
// (in memory: a restart simply invalidates outstanding codes). Asking for a new code is rate limited per address
// (one per minute, five per hour) so the form cannot be used to flood someone's inbox.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function createAuthCodes({ now = Date.now, ttlMs = 10 * 60_000, maxAttempts = 5, cooldownMs = 60_000, perHour = 5, maxEntries = 10_000 } = {}) {
  const salt = randomBytes(16).toString('hex');
  const entries = new Map();
  const hashOf = (key, code) => createHash('sha256').update(`${salt}:${key}:${code}`).digest();

  function prune(at) {
    if (entries.size <= maxEntries) return;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at && entry.sent.every((time) => time <= at - 3_600_000)) entries.delete(key);
    }
  }

  return {
    /** @returns {{code: string} | {limited: true, retryAfterSeconds: number}} */
    issue(email, type) {
      const at = now();
      const key = `${type}:${email}`;
      const previous = entries.get(key);
      const sent = (previous?.sent ?? []).filter((time) => time > at - 3_600_000);

      if (sent.length && at - sent.at(-1) < cooldownMs) return { limited: true, retryAfterSeconds: Math.ceil((cooldownMs - (at - sent.at(-1))) / 1000) };
      if (sent.length >= perHour) return { limited: true, retryAfterSeconds: Math.ceil((sent[0] + 3_600_000 - at) / 1000) };
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

      sent.push(at);
      entries.set(key, { hash: hashOf(key, code), expiresAt: at + ttlMs, attempts: 0, sent });
      prune(at);
      return { code };
    },
    /** True once for the right, unexpired code. Wrong guesses are counted against that code. */
    verify(email, type, code) {
      const at = now();
      const key = `${type}:${email}`;
      const entry = entries.get(key);

      if (!entry || entry.expiresAt <= at || entry.attempts >= maxAttempts || entry.used) return false;
      const candidate = hashOf(key, String(code ?? '').trim());

      if (!timingSafeEqual(candidate, entry.hash)) {
        entry.attempts += 1;
        return false;
      }
      entry.used = true;
      return true;
    },
    size: () => entries.size,
  };
}
