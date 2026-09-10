import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { Repositories } from '../store/repo.ts';
import type { OperationAction, OperationRow } from '../store/rows.ts';
import type { PageserverClient } from '../adapters/pageserver.ts';
import type { DockerClient } from '../adapters/docker.ts';
import type { ComputeClient } from '../adapters/compute.ts';
import type { ComputeSigner } from '../domain/compute-auth.ts';

/** Everything an operation step is allowed to touch (002 §5.5). */
export interface ReconcilerDeps {
  readonly repos: Repositories;
  readonly pageserver: PageserverClient;
  readonly docker: DockerClient;
  readonly compute: ComputeClient;
  readonly signer: ComputeSigner;
  readonly config: Config;
  readonly logger: Logger;
}

export interface StepContext extends ReconcilerDeps {
  readonly operation: OperationRow;
  readonly payload: Record<string, unknown>;
}

/** Steps must be idempotent: the loop re-runs from `cursor_step` after a crash or a retry. */
export interface OperationStep {
  readonly name: string;
  run(context: StepContext): Promise<void>;
}

export interface ActionDefinition {
  readonly action: OperationAction;
  steps(payload: Record<string, unknown>): OperationStep[];
}

export const step = (name: string, run: OperationStep['run']): OperationStep => ({ name, run });
