import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories } from '../../src/store/repo.ts';
import { createService } from '../../src/service.ts';
import { createApp, type AppEnv } from '../../src/http/app.ts';
import { configureRespond } from '../../src/http/respond.ts';
import { validators } from '../../src/http/validate.ts';
import { createReconciler } from '../../src/reconciler/loop.ts';
import { createComputeSigner } from '../../src/domain/compute-auth.ts';
import { nullLogger } from '../../src/logger.ts';
import { ERROR_CODES } from '../../src/http/errors.ts';
import type { Config } from '../../src/config.ts';
import { fakeAdapters } from '../support/fakes.ts';
import { authed, bootstrapForTest, testIdentity } from '../support/identity.ts';

/**
 * The error half of the management contract.
 *
 * `respond()` validates every 2xx body against the vendored schema, but failures used to leave
 * unvalidated. The spec types them as `GeneralError` — `{ message, code, request_id? }` — on every
 * operation's `default` response, so a failure that dropped a field or leaked a stack trace would
 * have shipped unnoticed.
 *
 * This suite walks every implemented `/api/v2` route with an unknown resource id and asserts the
 * shape of what comes back: a 4xx (never a 500, never a 200), a body that matches `GeneralError`, a
 * `code` from the documented vocabulary, and a `request_id` that matches the response header. It is
 * derived from the route table, so a new route is covered the moment it is registered.
 */

configureRespond({ validate: true });

const ROUTES_DIR = fileURLToPath(new URL('../../src/http/routes/', import.meta.url));
const KNOWN_CODES = new Set<string>(Object.values(ERROR_CODES));

interface Route {
  readonly verb: string;
  readonly path: string;
}

function managementRoutes(): Route[] {
  const routes: Route[] = [];
  for (const name of readdirSync(ROUTES_DIR)) {
    const text = readFileSync(join(ROUTES_DIR, name), 'utf8');
    for (const match of text.matchAll(/\bapi\.(get|post|patch|delete)\(\s*'([^']+)'/g)) {
      routes.push({ verb: match[1]!.toUpperCase(), path: match[2]! });
    }
  }
  // Only routes with a resource to miss: a parameterless route (/projects, /api_keys, /auth,
  // /users/me…) has no "unknown id" and answers 200 by design. /projects/shared is registered from
  // app.ts and is likewise a 200 by design.
  return routes.filter((route) => route.path.includes(':') && route.path !== '/projects/shared');
}

/** A plausible id that cannot exist: Neon ids are lowercase slugs with a digit suffix. */
const MISSING: Record<string, string> = {
  project_id: 'ghost-proj-000000',
  branch_id: 'br-ghost-branch-000000',
  endpoint_id: 'ep-ghost-endpoint-000000',
  role_name: 'ghost_role',
  database_name: 'ghost_db',
  key_id: '9999',
  org_id: 'org-ghost-000000',
  member_id: '00000000-0000-0000-0000-0000000000ff',
};

const workdir = mkdtempSync(join(tmpdir(), 'neon-cp-error-surface-'));
let app: Hono<AppEnv>;

function makeConfig(): Config {
  return {
    port: 0, dbPath: ':memory:', masterKey: randomBytes(32),
    pageserverUrl: 'http://pageserver.invalid', pageserverConnstring: 'host=pageserver port=6400',
    safekeepers: ['safekeeper1:5454'], neonTag: 'test', computeImageRepo: 'docker.io/neondatabase',
    dockerSocket: '/var/run/docker.sock', dockerNetwork: 'neon-cp-test',
    computeVolumeRoot: join(workdir, 'computes'), portRange: [55500, 55520],
    routeMode: 'proxy', zone: 'db.neon.localhost', proxyToken: undefined, validateResponses: true,
    identity: testIdentity(),
  };
}

beforeEach(() => {
  const config = makeConfig();
  const repos = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(repos, config.identity);
  const fakes = fakeAdapters();
  const service = createService({ repos, pageserver: fakes.pageserver, config, logger: nullLogger });
  const reconciler = createReconciler({
    repos, pageserver: fakes.pageserver, docker: fakes.docker, compute: fakes.compute,
    signer: createComputeSigner('test'), config, logger: nullLogger,
  });
  app = authed(createApp({ repos, service, config, logger: nullLogger, reconciler }));
});

const routes = managementRoutes();
const isValidGeneralError = validators().get('GeneralError');

describe('error surface', () => {
  it('covers every parameterised /api/v2 route except the literal shared listing', () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(routes.every((route) => route.path.includes(':'))).toBe(true);
    expect(routes.some((route) => route.path === '/projects/shared')).toBe(false);
  });

  it.each(routes.map((route) => [`${route.verb} ${route.path}`, route] as const))(
    '%s answers an unknown resource with a GeneralError, not a 500',
    async (_label, route) => {
      const needsBody = route.verb !== 'GET' && route.verb !== 'DELETE';
      const response = await app.request(
        `/api/v2${route.path.replace(/:([A-Za-z_]+)/g, (_match, name: string) => MISSING[name] ?? 'ghost')}`,
        needsBody
          ? { method: route.verb, headers: { 'content-type': 'application/json' }, body: '{}' }
          : { method: route.verb },
      );

      expect(response.status, `${route.verb} ${route.path} answered ${response.status}`).toBeLessThan(500);
      const body = await response.json() as Record<string, unknown>;
      expect(isValidGeneralError(body), `body did not match GeneralError: ${JSON.stringify(body)}`).toBe(true);
      expect(KNOWN_CODES.has(String(body.code)), `undocumented error code ${String(body.code)}`).toBe(true);
      expect(typeof body.message).toBe('string');
      expect(String(body.message)).not.toContain('at '); // no stack frames
      expect(body.request_id).toBe(response.headers.get('x-request-id'));
    },
  );
});

describe('error envelope', () => {
  it('never leaks an internal message for an unhandled failure', async () => {
    const config = makeConfig();
    const repos = createRepositories(openDatabase(':memory:'));
    bootstrapForTest(repos, config.identity);
    const fakes = fakeAdapters();
    fakes.pageserver.locationConfig = async () => { throw new Error('boom: /secret/path'); };
    const service = createService({ repos, pageserver: fakes.pageserver, config, logger: nullLogger });
    const broken = authed(createApp({
      repos, service, config, logger: nullLogger,
      reconciler: createReconciler({
        repos, pageserver: fakes.pageserver, docker: fakes.docker, compute: fakes.compute,
        signer: createComputeSigner('test'), config, logger: nullLogger,
      }),
    }));

    const response = await broken.request('/api/v2/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: { name: 'boom', pg_version: 17 } }),
    });
    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(String(body.message)).not.toContain('secret/path');
    expect(isValidGeneralError(body)).toBe(true);
  });

  it('answers an unknown path with a GeneralError instead of an HTML page', async () => {
    const response = await app.request('/api/v2/not-a-real-route');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    const body = await response.json() as Record<string, unknown>;
    expect(isValidGeneralError(body)).toBe(true);
    expect(body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

rmSync(workdir, { recursive: true, force: true });
