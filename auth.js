import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const [, salt, expected] = String(encoded).split('$');
  if (!salt || !expected) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
export function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
export function issueToken() { return randomBytes(32).toString('base64url'); }
export function id() { return randomUUID(); }
