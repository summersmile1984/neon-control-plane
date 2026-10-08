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
import { createComputeSigner } from '../../src/domain/compute-auth.ts';
import { bootstrapIdentity } from '../../src/domain/bootstrap.ts';
import { nullLogger } from '../../src/logger.ts';
import { fakeAdapters } from '../support/fakes.ts';

/**
 * The ledger only knows the ports this database handed out. A compute container left behind by
 * another instance (or by an earlier run) still owns its published port, Docker starts the new
 * container without that binding, and `await_ready` then polls the *other* compute until it gives
 * up on an authentication error. The reconciler must name the holder instead.
 */

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'neon-ports-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const config = loadConfig({ CP_MASTER_KEY: randomBytes(32).toString('base64'), CP_COMPUTE_VOLUME_ROOT: directory });
  const db = openDatabase(':memory:'); cleanup.push(() => db.close());
  const repos = createRepositories(db);
  bootstrapIdentity(repos, config.identity, nullLogger);
  const adapters = fakeAdapters();
  const reconciler = createReconciler({ repos, config, ...adapters, signer: createComputeSigner(), logger: nullLogger });
  const service = createService({ repos, config, pageserver: adapters.pageserver, logger: nullLogger });
  return { adapters, reconciler, repos, service };
}

describe('compute host ports', () => {
  it('refuses to start when another container already publishes the port', async () => {
    const { adapters, reconciler, repos, service } = fixture();
    const ports = service.allocatePorts();
    adapters.state.containers.set('ep-foreign', {
      id: 'ep-foreign', running: true, labels: {}, publishedPorts: [ports.pgPort],
    });

    const created = await service.createProject({ name: 'collides', pgVersion: 17 });
    await reconciler.drain();

    const operation = repos.operations.listByProject(created.project.id, 10).find((row) => row.action === 'start_compute');
    expect(operation?.error).toContain(`host port ${ports.pgPort} is published by container ep-foreign`);
    expect(operation?.status).not.toBe('finished');
    // The endpoint's own container is never created, so nothing can end up polling the neighbour.
    expect(adapters.state.createCalls).toBe(0);
  });

  it('starts normally once the conflicting container is gone', async () => {
    const { adapters, reconciler, repos, service } = fixture();
    vi.useFakeTimers();
    try {
      const ports = service.allocatePorts();
      adapters.state.containers.set('ep-foreign', {
        id: 'ep-foreign', running: true, labels: {}, publishedPorts: [ports.pgPort, ports.httpPort],
      });

      const created = await service.createProject({ name: 'clears', pgVersion: 17 });
      await reconciler.drain();
      expect(adapters.state.createCalls).toBe(0);

      adapters.state.containers.delete('ep-foreign');
      // The first failure rescheduled the operation 2s out. Advance the clock instead of sleeping:
      // `claimNext` compares retry_at against Date.now().
      for (let attempt = 0; attempt < 4; attempt += 1) {
        vi.advanceTimersByTime(1000);
        await reconciler.drain();
        if (repos.operations.listByProject(created.project.id, 10).every((row) => row.status === 'finished')) break;
      }
      expect(repos.operations.listByProject(created.project.id, 10).every((row) => row.status === 'finished')).toBe(true);
      expect(adapters.state.createCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});