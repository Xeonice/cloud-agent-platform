import type {
  CreateTaskBody,
  Runtime,
  RuntimeExecutionEnvironmentSnapshot,
} from '@cap/contracts';
import type { ExecutionMode } from '../agent-runtime/agent-runtime.port';

/**
 * Fully resolved, transaction-local input for one Task row.
 *
 * Construct this only through `TasksService.prepareTaskCreate()`. Everything
 * that may touch a credential, provider, sandbox image, catalog cache, or CLI
 * has already completed by the time this value reaches a write transaction.
 */
export interface PreparedTaskCreate {
  readonly repoId: string;
  readonly ownerUserId: string | null;
  readonly body: Readonly<CreateTaskBody>;
  readonly runtime: Runtime;
  readonly executionMode: ExecutionMode;
  readonly sandboxEnvironmentId: string | null;
  readonly model: string | null;
  readonly executionEnvironmentSnapshot: RuntimeExecutionEnvironmentSnapshot | null;
}
