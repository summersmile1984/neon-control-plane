import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories, type Repositories } from '../../src/store/repo.ts';
import { createService } from '../../src/service.ts';
import { createApp, type AppEnv } from '../../src/http/app.ts';
import { configureRespond } from '../../src/http/respond.ts';
import { createReconciler } from '../../src/reconciler/loop.ts';
import { createComputeSigner } from '../../src/domain/compute-auth.ts';
import { nullLogger } from '../../src/logger.ts';
import type { Config } from '../../src/config.ts';
import { fakeAdapters } from '../support/fakes.ts';
import { bootstrapForTest, testIdentity } from '../support/identity.ts';

/** Console login: local password, dev login, and the session cookie the API then accepts (design 004). */

configureRespond({ validate: true });

let app: Hono<AppEnv>;

function makeConfig(): Config {
  return {
    port: 0, dbPath: ':memory:', masterKey: randomBytes(32),
    pageserverUrl: 'http://pageserver.invalid', pageserverConnstring: 'host=pageserver port=6400',
    safekeepers: ['safekeeper1:5454'], neonTag: 'test', computeImageRepo: 'docker.io/neondatabase',
    dockerSocket: '/var/run/docker.sock', dockerNetwork: 'neon-cp-test',
    computeVolumeRoot: '/tmp/neon-cp-console-auth', portRange: [55500, 55520],
    routeMode: 'proxy', zone: 'db.neon.localhost', proxyToken: undefined, validateResponses: true,
    identity: testIdentity({ ownerPassword: 'correct-horse', devLogin: true }),
  };
}

function cookieOf(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = /=([^;]+)/.exec(header);
  return `${header.split('=')[0]}=${match?.[1] ?? ''}`;
}

beforeEach(() => {
  const config = makeConfig();
  const repos: Repositories = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(repos, config.identity);
  const fakes = fakeAdapters();
  const service = createService({ repos, pageserver: fakes.pageserver, config, logger: nullLogger });
  const reconciler = createReconciler({
    repos, pageserver: fakes.pageserver, docker: fakes.docker, compute: fakes.compute,
    signer: createComputeSigner('test'), config, logger: nullLogger,
  });
  app = createApp({ repos, service, config, logger: nullLogger, reconciler });
});

describe('console authentication', () => {
  it('serves the same single-page console at / and /console without a session', async () => {
    const root = await app.request('/');
    const console = await app.request('/console');
    const rootHtml = await root.text();
    const consoleHtml = await console.text();
    for (const [path, response, html] of [
      ['/', root, rootHtml],
      ['/console', console, consoleHtml],
    ] as const) {
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(/text\/html/);
      expect(html, path).toContain('<main>');
      expect(html, path).toContain('id="loginBtn"');
    }
    // Byte-identical: the root is an alias, not a second page that can drift.
    expect(rootHtml).toBe(consoleHtml);
  });

  it('advertises the enabled login methods', async () => {
    const body = (await (await app.request('/console/config')).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ login_required: true, password_login: true, dev_login: true });
  });

  it('signs in with email + password and accepts the session cookie on /api/v2', async () => {
    const login = await app.request('/console/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@test.local', password: 'correct-horse' }),
    });
    expect(login.status, await login.clone().text()).toBe(200);
    const cookie = cookieOf(login);
    expect(cookie).toMatch(/^zenith=/);

    const session = await app.request('/console/session', { headers: { cookie } });
    expect((await session.json()) as Record<string, unknown>).toMatchObject({ authenticated: true });

    const auth = await app.request('/api/v2/auth', { headers: { cookie } });
    expect(auth.status).toBe(200);
    expect((await auth.json()) as Record<string, unknown>).toMatchObject({ auth_method: 'session_cookie' });
  });

  it('rejects a wrong password', async () => {
    const login = await app.request('/console/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@test.local', password: 'wrong' }),
    });
    expect(login.status).toBe(401);
  });

  it('signs in through the dev-login button', async () => {
    const login = await app.request('/console/dev-login', { method: 'POST' });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    const auth = await app.request('/api/v2/auth', { headers: { cookie } });
    expect((await auth.json()) as Record<string, unknown>).toMatchObject({ auth_method: 'session_cookie' });
  });

  it('clears the session on logout', async () => {
    const login = await app.request('/console/dev-login', { method: 'POST' });
    const cookie = cookieOf(login);
    expect((await app.request('/api/v2/auth', { headers: { cookie } })).status).toBe(200);
    await app.request('/console/logout', { method: 'POST', headers: { cookie } });
    expect((await app.request('/api/v2/auth', { headers: { cookie } })).status).toBe(401);
  });
});
