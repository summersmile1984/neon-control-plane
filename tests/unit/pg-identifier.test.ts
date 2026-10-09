import { describe, expect, it } from 'vitest';
import { pgIdentifier } from '../../src/http/routes/helpers.ts';
describe('Neon role and database names', () => {
  it.each(['demo-workspace-database-7d36b453-role', 'app.v1', '1test', '_internal'])('accepts the bounded provider identifier %s', name => {
    expect(pgIdentifier(name, 'name')).toBe(name);
  });
  it.each(['bad name', 'x;DROP ROLE owner', 'x"', "x'", 'a'.repeat(64), 'x\n', ''])('rejects unsafe or oversized input %s', name => {
    expect(() => pgIdentifier(name, 'name')).toThrow();
  });
});
