import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { openDatabase } from './store/db.ts';
import { createRepositories } from './store/repo.ts';
import { createPageserverClient } from './adapters/pageserver.ts';
import { createDockerClient } from './adapters/docker.ts';
import { createComputeClient } from './adapters/compute.ts';
import { createComputeSigner, loadComputeSigner, type ComputeSigner } from './domain/compute-auth.ts';
import { createService } from './service.ts';
import { createReconciler } from './reconciler/loop.ts';
import { createApp } from './http/app.ts';
import { configureRespond } from './http/respond.ts';
import { bootstrapIdentity } from './domain/bootstrap.ts';

/**
 * Process entry point (002 §2): config -> db -> adapters -> service -> app -> reconciler.
 */

/**
 * The signing key must survive a restart: a compute started with the previous public JWK keeps
 * rejecting calls signed by a new key until it is reconfigured.
 */
function resolveSigner(keyPath: string, logger: ReturnType<typeof createLogger>): ComputeSigner {
  if (existsSync(keyPath)) return loadComputeSigner(readFileSync(keyPath, 'utf8'));
  const signer = createComputeSigner();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, signer.exportPrivateKey(), { mode: 0o600 });
  logger.info('generated a compute signing key', { path: keyPath, kid: signer.kid });
  return signer;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger((process.env.CP_LOG_LEVEL as 'debug' | 'info') ?? 'info');

  configureRespond({
    validate: config.validateResponses,
    onInvalid: (schemaName, message) => logger.error('response failed schema validation', { schema: schemaName, error: message }),
  });

  const db = openDatabase(config.dbPath);
  const repos = createRepositories(db);
  bootstrapIdentity(repos, config.identity, logger);
  const signer = resolveSigner(join(dirname(config.dbPath), 'compute-signing-key.pem'), logger);

  const pageserver = createPageserverClient({ baseUrl: config.pageserverUrl });
  const docker = createDockerClient({ socketPath: config.dockerSocket });
  const compute = createComputeClient({ signer });

  const service = createService({ repos, pageserver, config, logger });
  const reconciler = createReconciler({ repos, pageserver, docker, compute, signer, config, logger });

  if (!(await docker.ping())) logger.warn('docker is not reachable: compute operations will fail', { socket: config.dockerSocket });
  await pageserver.status().catch(() => logger.warn('pageserver is not reachable', { url: config.pageserverUrl }));

  const orphans = await reconciler.reclaimOrphans().catch(() => 0);
  if (orphans > 0) logger.warn('reclaimed orphan compute containers', { count: orphans });

  reconciler.start();
  const idleSweep = setInterval(() => {
    const queued = reconciler.sweepIdleEndpoints();
    if (queued > 0) logger.info('queued idle suspensions', { count: queued });
  }, 30_000);
  idleSweep.unref();

  // docker and pageserver are passed only so the console can report the stack's real state.
  const app = createApp({ repos, service, config, logger, reconciler, docker, pageserver });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info('neon-control-plane listening', {
      port: info.port, route_mode: config.routeMode, zone: config.zone,
      api_keys: repos.apiKeys.count(), pageserver: config.pageserverUrl,
    });
  });

  const shutdown = (): void => {
    logger.info('shutting down');
    reconciler.stop();
    clearInterval(idleSweep);
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    // The logger may not exist yet, so this is the one place a bare console call is right.
    console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
