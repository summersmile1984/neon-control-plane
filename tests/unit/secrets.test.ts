import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openPassword, parseMasterKey, sealPassword } from '../../src/domain/secrets.ts';

const key = randomBytes(32);

describe('password sealing', () => {
  it('round-trips a password', () => {
    const sealed = sealPassword('s3cret-value', key);
    expect(openPassword(sealed, key)).toBe('s3cret-value');
  });

  it('never emits the plaintext and uses a fresh nonce each time', () => {
    const first = sealPassword('same-input', key);
    const second = sealPassword('same-input', key);
    expect(first).not.toBe(second);
    expect(Buffer.from(first, 'base64').toString('utf8')).not.toContain('same-input');
  });

  it('rejects a wrong key and a tampered ciphertext', () => {
    const sealed = sealPassword('value', key);
    expect(() => openPassword(sealed, randomBytes(32))).toThrow();

    const raw = Buffer.from(sealed, 'base64');
    const last = raw.length - 1;
    raw.writeUInt8(raw.readUInt8(last) ^ 0xff, last);
    expect(() => openPassword(raw.toString('base64'), key)).toThrow();
  });

  it('rejects truncated input', () => {
    expect(() => openPassword(randomBytes(8).toString('base64'), key)).toThrow(/truncated/);
  });

  it('validates the master key length', () => {
    expect(parseMasterKey(randomBytes(32).toString('base64'))).toHaveLength(32);
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
