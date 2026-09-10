import { describe, expect, it } from 'vitest';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { formatScramSecret, generatePassword, parseScramSecret, scramParts, scramSha256, verifyScramPassword } from '../../src/domain/scram.ts';

describe('SCRAM-SHA-256 verifier', () => {
  it('produces the PostgreSQL rolpassword format', () => {
    const secret = scramSha256('hunter2', 4096, Buffer.alloc(16, 7));
    expect(secret).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    const parts = parseScramSecret(secret);
    expect(parts.iterations).toBe(4096);
    expect(Buffer.from(parts.salt)).toEqual(Buffer.alloc(16, 7));
    expect(parts.storedKey).toHaveLength(32);
    expect(parts.serverKey).toHaveLength(32);
  });

  it('derives StoredKey and ServerKey per RFC 5802', () => {
    const password = 'pencil';
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const iterations = 4096;
    const parts = scramParts(password, iterations, salt);

    const saltedPassword = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
    const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
    const expectedServerKey = createHmac('sha256', saltedPassword).update('Server Key').digest();

    expect(Buffer.from(parts.storedKey)).toEqual(createHash('sha256').update(clientKey).digest());
    expect(Buffer.from(parts.serverKey)).toEqual(expectedServerKey);
  });

  it('is deterministic for a fixed salt and random otherwise', () => {
    const salt = Buffer.alloc(16, 1);
    expect(scramSha256('same', 4096, salt)).toBe(scramSha256('same', 4096, salt));
    expect(scramSha256('same')).not.toBe(scramSha256('same'));
  });

  it('verifies the right password and rejects the wrong one', () => {
    const secret = scramSha256('correct horse battery staple');
    expect(verifyScramPassword('correct horse battery staple', secret)).toBe(true);
    expect(verifyScramPassword('correct horse battery stapl', secret)).toBe(false);
  });

  it('round-trips through parse and format', () => {
    const secret = scramSha256('round-trip');
    expect(formatScramSecret(parseScramSecret(secret))).toBe(secret);
  });

  it('rejects malformed verifiers and bad iteration counts', () => {
    expect(() => parseScramSecret('not-a-verifier')).toThrow(/malformed/);
    expect(() => scramParts('x', 0)).toThrow(/positive integer/);
  });

  it('generates URL-safe passwords that survive a connection URI unescaped', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const password = generatePassword();
      expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encodeURIComponent(password)).toBe(password);
    }
  });
});
