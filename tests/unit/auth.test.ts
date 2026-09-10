import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories } from '../../src/store/repo.ts';
import { API_KEY_PREFIX, bearerAuth, generateApiKey, hashApiKey } from '../../src/http/auth.ts';
import { ApiError } from '../../src/http/errors.ts';

function appWith(repos: ReturnType<typeof createRepositories>): Hono {
  const app = new Hono();
  app.onError((error, c) => (error instanceof ApiError ? c.json(error.toBody(), error.httpStatus as 401) : c.json({ code: 'X', message: 'x' }, 500)));
  app.use('*', bearerAuth(repos));
  app.get('/guarded', (c) => c.json({ ok: true }));
  return app;
}

describe('API keys', () => {
  it('generates prefixed keys and hashes them stably', () => {
    const key = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).toHaveLength(64);
    expect(hashApiKey(key)).not.toBe(hashApiKey(generateApiKey()));
  });

  it('runs open while no key exists, then enforces one', async () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const app = appWith(repos);

    expect((await app.request('/guarded')).status).toBe(200);

    const key = generateApiKey();
    repos.apiKeys.insert({ id: 'key_1', name: 'test', key_hash: hashApiKey(key) });

    expect((await app.request('/guarded')).status).toBe(401);
    expect((await app.request('/guarded', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await app.request('/guarded', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    expect((await app.request('/guarded', { headers: { authorization: `bearer ${key}` } })).status).toBe(200);
    expect(repos.apiKeys.findByHash(hashApiKey(key))?.last_used_at).toBeTruthy();
  });

  it('answers 401 with the GeneralError body', async () => {
    const repos = createRepositories(openDatabase(':memory:'));
    repos.apiKeys.insert({ id: 'key_1', name: 'test', key_hash: hashApiKey(generateApiKey()) });
    const response = await appWith(repos).request('/guarded');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'AUTH_FAILED' });
  });
});
