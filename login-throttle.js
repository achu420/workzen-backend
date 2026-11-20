// Brute-force protection for sign-in and other secret-guessing routes.
//
// Failed attempts are counted per key inside a sliding window; once a key has `maxAttempts` failures it is locked until
// the oldest one ages out. A successful sign-in clears that account's counter (never the IP's). The server keys every
// attempt twice: by account (so one person's password cannot be guessed from many addresses) and by client address (so
// one address cannot walk through many accounts). State is in memory: a restart forgets it, which is fine for a lockout
// measured in minutes.
export function createLoginThrottle({ maxAttempts = 10, windowMs = 15 * 60 * 1000, ipMaxAttempts = maxAttempts * 5, maxKeys = 20_000, now = Date.now } = {}) {
  const failures = new Map();

  function fresh(key, windowStart) {
    const list = (failures.get(key) ?? []).filter((time) => time > windowStart);

    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  }

  function limitFor(key) {
    return key.startsWith('ip:') ? ipMaxAttempts : maxAttempts;
  }

  return {
    /** @returns {{allowed: boolean, retryAfterSeconds: number}} for the most restrictive of the given keys. */
    check(keys) {
      const current = now();
      let retryAfterMs = 0;

      for (const key of keys) {
        const list = fresh(key, current - windowMs);

        if (list.length >= limitFor(key)) retryAfterMs = Math.max(retryAfterMs, list[0] + windowMs - current);
      }
      return { allowed: retryAfterMs === 0, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    },
    fail(keys) {
      const current = now();

      for (const key of keys) {
        const list = fresh(key, current - windowMs);

        list.push(current);
        failures.set(key, list);
      }
      if (failures.size > maxKeys) {
        // Memory bound under attack: drop the oldest-touched keys first (Map keeps insertion order).
        for (const key of failures.keys()) {
          if (failures.size <= maxKeys * 0.9) break;
          failures.delete(key);
        }
      }
    },
    clear(keys) {
      for (const key of keys) failures.delete(key);
    },
    size: () => failures.size,
  };
}

/** Client address, honouring X-Forwarded-For only when the operator says a trusted proxy sets it. */
export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();

    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
