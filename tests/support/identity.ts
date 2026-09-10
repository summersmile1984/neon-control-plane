import type { Hono } from 'hono';
import type { AppEnv } from '../../src/http/app.ts';
import type { IdentityConfig } from '../../src/config.ts';
import type { Repositories } from '../../src/store/repo.ts';
import { bootstrapIdentity } from '../../src/domain/bootstrap.ts';
import { nullLogger } from '../../src/logger.ts';

/**
 * Shared identity fixtures for the contract/e2e suites (design 004). The control plane always
 * requires auth, so every suite seeds the bootstrap owner + a known personal key and wraps the app
 * with `authed()` to present it.
 */

export const TEST_API_KEY = 'napi_test_api_key_0000000000000000000000';
export const TEST_ORG_ID = 'org-test-000000000001';
export const TEST_OWNER_ID = '00000000-0000-0000-0000-0000000000aa';

export function testIdentity(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    ownerId: TEST_OWNER_ID,
    ownerEmail: 'owner@test.local',
    ownerName: 'Test Owner',
    ownerLastName: '',
    ownerPassword: 'test-password',
    orgId: TEST_ORG_ID,
    orgName: 'Test Organization',
    keyPrefix: 'napi_',
    sessionTtlSeconds: 3600,
    devLogin: false,
    bootstrapApiKey: TEST_API_KEY,
    oidc: undefined,
    ...overrides,
  };
}

export function bootstrapForTest(repos: Repositories, identity: IdentityConfig): void {
  bootstrapIdentity(repos, identity, nullLogger);
}

/** Wraps a Hono app so requests carry a bearer key unless the caller supplied an authorization header. */
export function authed(app: Hono<AppEnv>, key: string = TEST_API_KEY): Hono<AppEnv> {
  return new Proxy(app, {
    get(target, prop, receiver) {
      if (prop === 'request') {
        return (input: string | Request, init: RequestInit = {}) => {
          const headers = new Headers(init.headers as Record<string, string> | undefined);
          if (!headers.has('authorization')) headers.set('authorization', `Bearer ${key}`);
          return target.request(input, { ...init, headers });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Hono<AppEnv>;
}
