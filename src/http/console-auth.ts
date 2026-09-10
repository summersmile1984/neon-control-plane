import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppDeps, AppEnv } from './app.ts';
import { errors } from './errors.ts';
import { createSession, destroySession, verifyPassword, SESSION_COOKIE } from '../domain/session.ts';
import { resolvePrincipal } from './auth.ts';
import type { UserRow } from '../store/rows.ts';

/**
 * Console authentication (design 004), served outside `/api/v2` because it is not part of the Neon
 * HTTP contract. Three ways in, matching what the official console offers in spirit:
 *
 *   POST /console/login        local email + password
 *   POST /console/dev-login    one-click bootstrap owner (CP_DEV_LOGIN only)
 *   GET  /console/oidc/start + /console/oidc/callback   generic OIDC authorization-code flow
 *
 * All three end by issuing the same opaque session cookie the `zenith` `CookieAuth` scheme declares,
 * so the API authenticates a browser exactly as it authenticates an API key.
 */

const OIDC_STATE_COOKIE = 'cp_oidc_state';
const COOKIE_PATH = '/';

function sessionCookieOptions(ttlSeconds: number): Parameters<typeof setCookie>[3] {
  return { httpOnly: true, sameSite: 'Lax', path: COOKIE_PATH, maxAge: ttlSeconds, secure: false };
}

export function registerConsoleAuthRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const { repos, config } = deps;
  const identity = config.identity;

  const issue = (userId: string): { token: string; expiresAt: string } => createSession(repos, userId, identity.sessionTtlSeconds);

  const login = (c: Context<AppEnv>, userId: string): Response => {
    const { token } = issue(userId);
    setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(identity.sessionTtlSeconds));
    const user = repos.users.get(userId);
    return c.json({ ok: true, user: user ? { id: user.id, email: user.email, name: user.name } : null });
  };

  app.get('/console/config', (c) => c.json({
    login_required: true,
    password_login: Boolean(identity.ownerPassword),
    dev_login: identity.devLogin,
    oidc: identity.oidc ? { enabled: true } : { enabled: false },
  }));

  app.get('/console/session', (c) => {
    const principal = resolvePrincipal(repos, { cookieToken: getCookie(c, SESSION_COOKIE) ?? null });
    if (!principal?.userId) return c.json({ authenticated: false }, 200);
    const user = repos.users.get(principal.userId);
    return c.json({ authenticated: true, user: user ? { id: user.id, email: user.email, name: user.name } : null });
  });

  app.post('/console/login', async (c) => {
    const body = await readJson(c);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) throw errors.badRequest('email and password are required');
    const user = repos.users.getByEmail(email);
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      throw errors.unauthorized('email or password is incorrect');
    }
    return login(c, user.id);
  });

  app.post('/console/dev-login', async (c) => {
    if (!identity.devLogin) throw errors.forbidden('dev login is disabled');
    let user = repos.users.get(identity.ownerId);
    if (!user) {
      user = repos.users.insert({
        id: identity.ownerId, email: identity.ownerEmail, name: identity.ownerName,
        last_name: identity.ownerLastName, image: '', password_hash: null,
      });
    }
    return login(c, user.id);
  });

  app.post('/console/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) destroySession(repos, token);
    deleteCookie(c, SESSION_COOKIE, { path: COOKIE_PATH });
    return c.json({ ok: true });
  });

  // --- generic OIDC ---------------------------------------------------------------------------

  app.get('/console/oidc/start', async (c) => {
    const oidc = identity.oidc;
    if (!oidc) throw errors.forbidden('OIDC login is not configured');
    const discovery = await discover(oidc.issuer);
    const state = randomUUID();
    const verifier = randomUUID().replace(/-/g, '');
    const challenge = await pkceChallenge(verifier);
    setCookie(c, OIDC_STATE_COOKIE, JSON.stringify({ state, verifier }), { ...sessionCookieOptions(600), httpOnly: true });
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', oidc.clientId);
    url.searchParams.set('redirect_uri', oidc.redirectUri);
    url.searchParams.set('scope', oidc.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return c.redirect(url.toString());
  });

  app.get('/console/oidc/callback', async (c) => {
    const oidc = identity.oidc;
    if (!oidc) throw errors.forbidden('OIDC login is not configured');
    const code = c.req.query('code');
    const state = c.req.query('state');
    const raw = getCookie(c, OIDC_STATE_COOKIE);
    deleteCookie(c, OIDC_STATE_COOKIE, { path: COOKIE_PATH });
    if (!code || !state || !raw) throw errors.badRequest('OIDC callback is missing code or state');
    let stored: { state: string; verifier: string };
    try { stored = JSON.parse(raw) as { state: string; verifier: string }; } catch { throw errors.badRequest('OIDC state cookie is invalid'); }
    if (stored.state !== state) throw errors.badRequest('OIDC state does not match');

    const discovery = await discover(oidc.issuer);
    const token = await exchangeCode(discovery.token_endpoint, {
      grant_type: 'authorization_code', code, redirect_uri: oidc.redirectUri,
      client_id: oidc.clientId, code_verifier: stored.verifier,
      ...(oidc.clientSecret ? { client_secret: oidc.clientSecret } : {}),
    });
    const claims = await fetchUserInfo(discovery.userinfo_endpoint, token.access_token, token.id_token);
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    if (!email) throw errors.badRequest('OIDC provider did not return an email');

    const user = upsertOidcUser(repos, config.identity.orgId, {
      email,
      name: typeof claims.name === 'string' ? claims.name : email,
      image: typeof claims.picture === 'string' ? claims.picture : '',
    });
    login(c, user.id);
    return c.redirect('/console');
  });

  async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
    try {
      const raw = await c.req.json();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      return raw as Record<string, unknown>;
    } catch {
      throw errors.badRequest('request body must be a JSON object');
    }
  }
}

interface Discovery { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string }

async function discover(issuer: string): Promise<Discovery> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw errors.internal(`OIDC discovery failed with ${response.status}`);
  const doc = (await response.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw errors.internal('OIDC discovery document is incomplete');
  return doc;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(verifier).digest('base64url');
}

async function exchangeCode(tokenEndpoint: string, form: Record<string, string>): Promise<{ access_token: string; id_token?: string }> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  if (!response.ok) throw errors.unauthorized(`OIDC token exchange failed with ${response.status}`);
  return (await response.json()) as { access_token: string; id_token?: string };
}

function decodeJwtClaims(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try { return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return {}; }
}

async function fetchUserInfo(userinfoEndpoint: string | undefined, accessToken: string, idToken?: string): Promise<Record<string, unknown>> {
  if (userinfoEndpoint) {
    const response = await fetch(userinfoEndpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
    if (response.ok) return (await response.json()) as Record<string, unknown>;
  }
  return decodeJwtClaims(idToken);
}

function upsertOidcUser(repos: AppDeps['repos'], orgId: string, input: { email: string; name: string; image: string }): UserRow {
  const existing = repos.users.getByEmail(input.email);
  if (existing) {
    if (!repos.members.getByUserAndOrg(existing.id, orgId)) {
      repos.members.insert({ id: randomUUID(), org_id: orgId, user_id: existing.id, role: 'member' });
    }
    return existing;
  }
  const user = repos.users.insert({
    id: randomUUID(), email: input.email, name: input.name, last_name: '', image: input.image,
    // OIDC users have no local password; the identity provider is the only way in.
    password_hash: null,
  });
  repos.members.insert({ id: randomUUID(), org_id: orgId, user_id: user.id, role: 'member' });
  return user;
}
