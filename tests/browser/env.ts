/**
 * Shared constants for the browser suite (design 004). The Playwright config starts the control
 * plane with these exact env values; the specs import the same module so they cannot drift.
 *
 * The suite drives the *real* control plane (`pnpm dev`) — there is no in-process fake. Login, key
 * management and membership work without the storage layer; project lifecycle cases additionally
 * require `pnpm compose:up` (pageserver) and skip when it is down.
 */

export const CP_PORT = Number(process.env.CP_BROWSER_PORT ?? 8080);
export const OIDC_PORT = Number(process.env.CP_BROWSER_OIDC_PORT ?? 9099);
export const BASE_URL = `http://127.0.0.1:${CP_PORT}`;

/** Must equal CP_BOOTSTRAP_API_KEY in the webServer command below. */
export const BOOTSTRAP_KEY = 'napi_browser_e2e_key';
export const OWNER_EMAIL = 'owner@neon.localhost';
export const OWNER_PASSWORD = 'browser-e2e-password';
export const ORG_ID = 'org-super-glade-55833945';

/** OIDC identity the fake provider signs in as. */
export const OIDC_EMAIL = 'oidc-user@neon.localhost';

export const CONTROL_PLANE_ENV = {
  CP_PORT: String(CP_PORT),
  // A dedicated database, port range and routing tier so the suite never collides with a running
  // `pnpm dev`. `direct` publishes the compute port on the host, which lets the data-plane spec
  // reach the compute with the exact connection URI the console hands out.
  CP_DB_PATH: 'data/browser-e2e.sqlite',
  CP_PORT_RANGE: '55800-55820',
  CP_ROUTE_MODE: 'direct',
  CP_BOOTSTRAP_API_KEY: BOOTSTRAP_KEY,
  CP_OWNER_PASSWORD: OWNER_PASSWORD,
  CP_OWNER_EMAIL: OWNER_EMAIL,
  CP_DEV_LOGIN: '1',
  CP_ORG_ID: ORG_ID,
  CP_OIDC_ISSUER: `http://127.0.0.1:${OIDC_PORT}`,
  CP_OIDC_CLIENT_ID: 'neon-control-plane',
  CP_OIDC_REDIRECT_URI: `${BASE_URL}/console/oidc/callback`,
  CP_OIDC_SCOPES: 'openid email profile',
} as const;
