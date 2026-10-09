import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/**
 * The generic OIDC authorization-code flow, end to end against a stub provider: `/console/oidc/start`
 * redirects with PKCE and a state cookie, `/console/oidc/callback` exchanges the code, reads the
 * userinfo, upserts the user and issues the same session cookie the password login issues.
 *
 * The browser suite walks the same flow against a real browser; this one keeps both routes inside
 * the fast contract tier, where a broken redirect chain fails in seconds instead of at the end of
 * the e2e run.
 */

configureRespond({ validate: true });

const ISSUER_USER = { sub: 'oidc-1', email: 'oidc-user@test.local', name: 'OIDC User' };
const CODE = 'authorization-code-from-provider';

let provider: Server;
let issuer = '';
let app: Hono<AppEnv>;
let repos: Repositories;
let tokensServed: Array<Record<string, string>> = [];

beforeAll(async () => {
  provider = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://provider');
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
      });
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        tokensServed.push(Object.fromEntries(new URLSearchParams(body)) as Record<string, string>);
        json(200, { access_token: 'access-token', id_token: 'id-token', token_type: 'Bearer' });
      });
      return;
    }
    if (url.pathname === '/userinfo') {
      json(200, ISSUER_USER);
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (typeof address === 'string' || address === null) throw new Error('provider did not bind a port');
  issuer = `http://127.0.0.1:${address.port}`;

  const config: Config = {
    port: 0, dbPath: ':memory:', masterKey: randomBytes(32),
    pageserverUrl: 'http://pageserver.invalid', pageserverConnstring: 'host=pageserver port=6400',
    safekeepers: ['safekeeper1:5454'], neonTag: 'test', computeImageRepo: 'docker.io/neondatabase',
    dockerSocket: '/var/run/docker.sock', dockerNetwork: 'neon-cp-test',
    computeVolumeRoot: '/tmp/neon-cp-console-oidc', portRange: [55500, 55520],
    routeMode: 'proxy', zone: 'db.neon.localhost', proxyToken: undefined, validateResponses: true,
    identity: testIdentity({
      devLogin: false,
      oidc: {
        issuer,
        clientId: 'neon-control-plane',
        clientSecret: undefined,
        redirectUri: 'http://localhost:8080/console/oidc/callback',
        scopes: 'openid email profile',
      },
    }),
  };
  repos = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(repos, config.identity);
  const fakes = fakeAdapters();
  const service = createService({ repos, pageserver: fakes.pageserver, config, logger: nullLogger });
  const reconciler = createReconciler({
    repos, pageserver: fakes.pageserver, docker: fakes.docker, compute: fakes.compute,
    signer: createComputeSigner('test'), config, logger: nullLogger,
  });
  app = createApp({ repos, service, config, logger: nullLogger, reconciler });
});

afterAll(async () => {
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

const setCookies = (response: Response): string[] =>
  (response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']).filter(Boolean);

const cookieValue = (response: Response, name: string): string => {
  const raw = setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
  if (!raw) throw new Error(`no ${name} cookie in ${JSON.stringify(setCookies(response))}`);
  return raw.slice(name.length + 1).split(';')[0]!;
};

describe('console OIDC login', () => {
  it('redirects to the provider with PKCE and a state cookie', async () => {
    const response = await app.request('/console/oidc/start');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${issuer}/authorize`);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('client_id')).toBe('neon-control-plane');
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:8080/console/oidc/callback');
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(cookieValue(response, 'cp_oidc_state')).toBeTruthy();
  });

  it('refuses a callback whose state does not match the cookie', async () => {
    const start = await app.request('/console/oidc/start');
    const cookie = setCookies(start).map((entry) => entry.split(';')[0]).join('; ');
    const response = await app.request('/console/oidc/callback?code=abc&state=forged', { headers: { cookie } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('OIDC state does not match');
  });

  it('refuses a callback with no state cookie at all', async () => {
    const response = await app.request('/console/oidc/callback?code=abc&state=whatever');
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('missing code or state');
  });

  it('exchanges the code and signs the browser in with the session cookie', async () => {
    tokensServed = [];
    const start = await app.request('/console/oidc/start');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state')!;
    const cookies = setCookies(start).map((entry) => entry.split(';')[0]).join('; ');

    const response = await app.request(`/console/oidc/callback?code=${CODE}&state=${state}`, {
      headers: { cookie: cookies },
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/console');

    // The verifier travelled in the cookie and reached the token endpoint as the PKCE challenge pair.
    expect(tokensServed).toHaveLength(1);
    expect(tokensServed[0]).toMatchObject({
      grant_type: 'authorization_code', code: CODE,
      redirect_uri: 'http://localhost:8080/console/oidc/callback', client_id: 'neon-control-plane',
    });
    expect(tokensServed[0]!.code_verifier).toBeTruthy();

    // A session cookie was issued, and it authenticates the API exactly like a password login does.
    const session = setCookies(response).find((cookie) => cookie.startsWith('zenith='))!;
    expect(session).toBeTruthy();
    const me = await app.request('/api/v2/users/me', { headers: { cookie: `zenith=${session.slice(7).split(';')[0]}` } });
    expect(me.status).toBe(200);
    const body = await me.json() as { email?: string };
    expect(body.email).toBe(ISSUER_USER.email);

    // The user was created on first login rather than silently mapped onto the bootstrap owner.
    expect(repos.users.getByEmail(ISSUER_USER.email)?.id).toBeTruthy();
  });
});
