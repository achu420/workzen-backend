import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEY_BYTES = 32;
const HKDF_SALT = Buffer.from('appflowy-independent-ai-keys');
const HKDF_INFO = Buffer.from('ai-key-v1');

// AI_KEY_SECRET may be 32 raw bytes as 64 hex chars, 32 bytes as base64, or any
// passphrase (stretched with HKDF). Returns a 32-byte key.
export function deriveSecretKey(secret) {
  const value = String(secret).trim();

  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');

    if (decoded.length === KEY_BYTES) return decoded;
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(value, 'utf8'), HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

// Uses AI_KEY_SECRET when set; otherwise creates a random secret once and keeps
// it in a 0600 file so stored keys stay decryptable across restarts.
export async function resolveAiSecret({ secret, secretFile }) {
  if (secret && String(secret).trim()) return deriveSecretKey(secret);
  try {
    return deriveSecretKey(await readFile(secretFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const generated = randomBytes(KEY_BYTES).toString('hex');

  await mkdir(path.dirname(secretFile), { recursive: true });
  await writeFile(secretFile, `${generated}\n`, { mode: 0o600, flag: 'wx' }).catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await chmod(secretFile, 0o600).catch(() => {});
  return deriveSecretKey(await readFile(secretFile, 'utf8'));
}

// The workspace id is bound as additional authenticated data, so a ciphertext copied
// into another workspace's row fails authentication instead of decrypting.
export function createKeyVault(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('AI key vault needs a 32-byte key');

  return {
    encrypt(workspaceId, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);

      cipher.setAAD(Buffer.from(String(workspaceId), 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

      return {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        last4: String(plaintext).slice(-4),
      };
    },
    decrypt(workspaceId, record) {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));

      decipher.setAAD(Buffer.from(String(workspaceId), 'utf8'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}
