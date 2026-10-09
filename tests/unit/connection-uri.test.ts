import { describe, expect, it } from 'vitest';
import { buildConnectionUri, connectionParameters, endpointHost } from '../../src/domain/connection-uri.ts';

const endpoint = { id: 'ep-quiet-river-a1b2c3d4', pgPort: 55501 };
const base = { zone: 'db.neon.localhost', endpoint, database: 'neondb', role: 'neondb_owner', password: 'pw-123' } as const;

describe('connection URI assembly', () => {
  it('direct mode points at the published host port without TLS', () => {
    expect(buildConnectionUri({ ...base, mode: 'direct' }))
      .toBe('postgresql://neondb_owner:pw-123@127.0.0.1:55501/neondb?sslmode=disable');
  });

  it('sni-router mode encodes service--namespace--port in the first label', () => {
    expect(buildConnectionUri({ ...base, mode: 'sni-router' }))
      .toBe('postgresql://neondb_owner:pw-123@ep-quiet-river-a1b2c3d4--compute--55433.db.neon.localhost/neondb?sslmode=require&channel_binding=require');
  });

  it('proxy mode uses the bare endpoint id as the first label, like Neon cloud', () => {
    expect(buildConnectionUri({ ...base, mode: 'proxy' }))
      .toBe('postgresql://neondb_owner:pw-123@ep-quiet-river-a1b2c3d4.db.neon.localhost/neondb?sslmode=require&channel_binding=require');
  });

  it('pooled hosts get the -pooler suffix on the routed modes', () => {
    expect(endpointHost('proxy', base.zone, endpoint.id, true)).toBe('ep-quiet-river-a1b2c3d4-pooler.db.neon.localhost');
    expect(endpointHost('direct', base.zone, endpoint.id, true)).toBe('127.0.0.1');
  });

  it('percent-encodes role, password and database', () => {
    const uri = buildConnectionUri({ ...base, mode: 'proxy', role: 'owner name', password: 'p@ss/word', database: 'my db' });
    expect(uri).toContain('owner%20name:p%40ss%2Fword@');
    expect(uri).toContain('/my%20db?');
    // routed modes omit the port and require channel binding, matching what Neon Cloud emits
    expect(uri).not.toContain(':5432/');
  });

  it('exposes the same values as structured parameters', () => {
    expect(connectionParameters({ ...base, mode: 'proxy' })).toEqual({
      host: 'ep-quiet-river-a1b2c3d4.db.neon.localhost',
      port: 5432,
      database: 'neondb',
      role: 'neondb_owner',
      password: 'pw-123',
      sslmode: 'require',
    });
  });

  it('produces a host that satisfies the client endpoint.host validator', () => {
    for (const mode of ['direct', 'sni-router', 'proxy'] as const) {
      expect(endpointHost(mode, base.zone, endpoint.id)).toMatch(/^[A-Za-z0-9.-]{1,253}$/);
    }
  });
});
