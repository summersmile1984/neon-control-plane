import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Role passwords are recoverable by design: the v2 API exposes `reveal_password` (002 §9, 卡点 7).
 * They are stored as AES-256-GCM ciphertext keyed by CP_MASTER_KEY, which lives only in the
 * process environment. Layout: base64( iv[12] | tag[16] | ciphertext ).
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function parseMasterKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) throw new Error(`CP_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  return key;
}

export function sealPassword(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function openPassword(sealed: string, masterKey: Buffer): string {
  const raw = Buffer.from(sealed, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('sealed password is truncated');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
