import { stepsFor } from './actions.ts';
import type { ReconcilerDeps, StepContext } from './types.ts';

/**
 * Single-threaded operation runner (002 §5.5).
 *
 *   claim (CAS) -> run steps from cursor_step -> finished
 *                                             -> retry with exponential backoff (max 5 failures)
 *
 * `claimNext` already refuses to pick up a second operation for a branch or endpoint that has one
 * running, so the loop never needs its own locking.
 */

export const MAX_FAILURES = 5;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

export function backoffMs(failures: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, failures), MAX_BACKOFF_MS);
}

/** Classified, safe-to-log failure phrase: never the backend's raw payload. */
export function classifyError(error: unknown): string {
  if (error instanceof Error) {
    const [firstLine = error.name] = error.message.split('\n');
    return firstLine.slice(0, 200);
  }
  return 'unknown error';
}

export interface Reconciler {
  /** Runs at most one operation. Returns the operation id when it ran something. */
  tick(): Promise<string | undefined>;
  /** Runs ticks until no operation is claimable; useful in tests and on startup. */
  drain(maxOperations?: number): Promise<number>;
  start(intervalMs?: number): void;
  stop(): void;
  /** Suspends endpoints idle for longer than their `suspend_timeout_seconds` (T-303). */
  sweepIdleEndpoints(): number;
  /** Removes compute containers that no longer have a live endpoint row (T-902). */
  reclaimOrphans(): Promise<number>;
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function runOperation(operationId: string): Promise<void> {
    const operation = deps.repos.operations.get(operationId);
    if (!operation) return;
    const logger = deps.logger.child({ operation_id: operation.id, action: operation.action, project_id: operation.project_id });
    const payload = JSON.parse(operation.payload_json) as Record<string, unknown>;
    const startedAt = Date.now();

    let steps;
    try {
      steps = stepsFor(operation.action, payload);
    } catch (error) {
      deps.repos.operations.fail(operation.id, classifyError(error), Date.now() - startedAt);
      logger.error('operation has no step definition', { error: classifyError(error) });
      return;
    }

    for (let index = operation.cursor_step; index < steps.length; index += 1) {
      const current = steps[index]!;
      const context: StepContext = { ...deps, operation, payload, logger: logger.child({ step: current.name }) };
      try {
        await current.run(context);
        deps.repos.operations.advance(operation.id, index + 1);
        logger.debug('step finished', { step: current.name });
      } catch (error) {
        const message = `step ${current.name}: ${classifyError(error)}`;
        const failures = operation.failures_count + 1;
        if (failures >= MAX_FAILURES) {
          deps.repos.operations.fail(operation.id, message, Date.now() - startedAt);
          logger.error('operation failed permanently', { step: current.name, failures, error: message });
        } else {
          const retryAt = new Date(Date.now() + backoffMs(operation.failures_count)).toISOString();
          deps.repos.operations.reschedule(operation.id, retryAt, message);
          logger.warn('operation rescheduled', { step: current.name, failures, retry_at: retryAt });
        }
        return;
      }
    }

    deps.repos.operations.finish(operation.id, Date.now() - startedAt);
    logger.info('operation finished', { duration_ms: Date.now() - startedAt });
  }

  const reconciler: Reconciler = {
    async tick() {
      if (running) return undefined;
      running = true;
      try {
        const claimed = deps.repos.operations.claimNext(new Date().toISOString());
        if (!claimed) return undefined;
        await runOperation(claimed.id);
        return claimed.id;
      } finally {
        running = false;
      }
    },

    async drain(maxOperations = 50) {
      let count = 0;
      for (let index = 0; index < maxOperations; index += 1) {
        const ran = await reconciler.tick();
        if (!ran) break;
        count += 1;
      }
      return count;
    },

    start(intervalMs = 250) {
      if (timer) return;
      timer = setInterval(() => {
        void reconciler.tick().catch((error) => deps.logger.error('reconciler tick failed', { error: classifyError(error) }));
      }, intervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    sweepIdleEndpoints() {
      let queued = 0;
      for (const endpoint of deps.repos.endpoints.listActive()) {
        if (endpoint.suspend_timeout_seconds <= 0) continue;
        const since = Date.parse(endpoint.last_active ?? endpoint.started_at ?? endpoint.created_at);
        if (Number.isNaN(since)) continue;
        if (Date.now() - since < endpoint.suspend_timeout_seconds * 1000) continue;
        if (deps.repos.operations.hasActiveFor({ endpoint_id: endpoint.id })) continue;
        deps.repos.operations.insert({
          id: crypto.randomUUID(),
          project_id: endpoint.project_id,
          branch_id: endpoint.branch_id,
          endpoint_id: endpoint.id,
          action: 'suspend_compute',
          payload: { endpoint_id: endpoint.id },
        });
        queued += 1;
      }
      return queued;
    },

    async reclaimOrphans() {
      const containers = await deps.docker.listByLabel('neon-cp.endpoint_id');
      let removed = 0;
      for (const container of containers) {
        const endpointId = container.labels['neon-cp.endpoint_id'];
        if (endpointId && deps.repos.endpoints.get(endpointId)) continue;
        await deps.docker.removeContainer(container.id, true);
        deps.logger.warn('removed orphan compute container', { container: container.name });
        removed += 1;
      }
      return removed;
    },
  };

  return reconciler;
}
