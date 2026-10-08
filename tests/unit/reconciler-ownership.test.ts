import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories } from '../../src/store/repo.ts';
import { createService } from '../../src/service.ts';
import { createReconciler } from '../../src/reconciler/loop.ts';
import { LABEL_ENDPOINT, LABEL_INSTANCE } from '../../src/reconciler/actions.ts';
import { createComputeSigner } from '../../src/domain/compute-auth.ts';
import { bootstrapIdentity } from '../../src/domain/bootstrap.ts';
import { nullLogger } from '../../src/logger.ts';
import { fakeAdapters } from '../support/fakes.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function fixture(instanceId?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'neon-ownership-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const config = loadConfig({ CP_MASTER_KEY: randomBytes(32).toString('base64'), CP_COMPUTE_VOLUME_ROOT: directory, ...(instanceId ? { CP_INSTANCE_ID: instanceId } : {}) });
  const db = openDatabase(':memory:'); cleanup.push(() => db.close());
  const repos = createRepositories(db);
  bootstrapIdentity(repos, config.identity, nullLogger);
  const adapters = fakeAdapters();
  const reconciler = createReconciler({ repos, config, ...adapters, signer: createComputeSigner(), logger: nullLogger });
  const service = createService({ repos, config, pageserver: adapters.pageserver, logger: nullLogger });
  return { adapters, reconciler, service };
}

describe('startup compute ownership', () => {
  it('does not enumerate or delete global containers when no instance is configured', async () => {
    const { adapters, reconciler } = fixture();
    const list = vi.spyOn(adapters.docker, 'listByLabel');
    const remove = vi.spyOn(adapters.docker, 'removeContainer');
    expect(await reconciler.reclaimOrphans()).toBe(0);
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('labels newly created computes and reclaims only its own unregistered endpoints', async () => {
    const { adapters, reconciler, service } = fixture('probe-a');
    const created = await service.createProject({ name: 'owned', pgVersion: 17 });
    await reconciler.drain();
    const existing = [...adapters.state.containers.values()].find((entry) => entry.labels[LABEL_ENDPOINT] === created.endpoint?.id);
    expect(existing?.labels[LABEL_INSTANCE]).toBe('probe-a');
    for (const [id, labels] of [
      ['own-orphan', { [LABEL_INSTANCE]: 'probe-a', [LABEL_ENDPOINT]: 'missing-a' }],
      ['foreign-orphan', { [LABEL_INSTANCE]: 'probe-b', [LABEL_ENDPOINT]: 'missing-b' }],
      ['legacy', { [LABEL_ENDPOINT]: 'missing-legacy' }],
      ['not-a-compute', { [LABEL_INSTANCE]: 'probe-a' }],
    ] as const) adapters.state.containers.set(id, { id, running: true, labels });
    expect(await reconciler.reclaimOrphans()).toBe(1);
    expect(adapters.state.containers.has('own-orphan')).toBe(false);
    for (const id of ['foreign-orphan', 'legacy', 'not-a-compute']) expect(adapters.state.containers.has(id)).toBe(true);
    expect([...adapters.state.containers.values()]).toContain(existing);
    expect(await reconciler.reclaimOrphans()).toBe(0);
  });

  it('rejects an invalid ownership identifier without echoing it', () => {
    expect(() => loadConfig({ CP_MASTER_KEY: randomBytes(32).toString('base64'), CP_INSTANCE_ID: 'invalid value/private' })).toThrow('CP_INSTANCE_ID must be a 1-64 character ownership identifier');
  });
});
