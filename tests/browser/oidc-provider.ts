import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A minimal OIDC provider for the browser suite (design 004). It implements just enough of the
 * authorization-code flow for `/console/oidc/start` and `/console/oidc/callback` to run end to end
 * against the real control plane: discovery, an auto-approving `/authorize`, `/token` and
 * `/userinfo`.
 *
 * It is not a security boundary and must never be reachable outside a test run.
 */

const PORT = Number(process.env.CP_BROWSER_OIDC_PORT ?? 9099);
const ISSUER = `http://127.0.0.1:${PORT}`;
const EMAIL = process.env.CP_OIDC_TEST_EMAIL ?? 'oidc-user@neon.localhost';
const NAME = process.env.CP_OIDC_TEST_NAME ?? 'OIDC User';

const codes = new Map<string, string>();

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function form(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ISSUER);

  if (url.pathname === '/.well-known/openid-configuration') {
    return send(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['none'],
    });
  }

  if (url.pathname === '/authorize') {
    const redirect = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') ?? '';
    if (!redirect) return send(res, 400, { error: 'invalid_request' });
    const code = `code_${Math.random().toString(36).slice(2)}`;
    codes.set(code, EMAIL);
    const target = new URL(redirect);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    res.writeHead(302, { location: target.toString() });
    return res.end();
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    const body = await form(req);
    const email = codes.get(body.code ?? '') ?? EMAIL;
    const idToken = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ iss: ISSUER, aud: body.client_id, sub: email, email, name: NAME })}.`;
    return send(res, 200, { access_token: 'test-access-token', id_token: idToken, token_type: 'Bearer', expires_in: 3600 });
  }

  if (url.pathname === '/userinfo') {
    return send(res, 200, { sub: EMAIL, email: EMAIL, name: NAME, picture: '' });
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`fake oidc provider listening on ${ISSUER}\n`);
});
