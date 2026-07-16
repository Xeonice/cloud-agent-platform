import type {
  CreateTaskBody,
  Runtime,
  RuntimeExecutionEnvironmentSnapshot,
} from '@cap/contracts';
import type { ExecutionMode } from '../agent-runtime/agent-runtime.port';
import type { SandboxResourceSnapshot } from '@cap/sandbox';

export type PreparedTaskAdmissionMode = 'legacy' | 'durable-v2';

/**
 * Fully resolved, transaction-local input for one Task row.
 *
 * Construct this only through `TasksService.prepareTaskCreate()`. Everything
 * that may touch a credential, provider, sandbox image, catalog cache, or CLI
 * has already completed by the time this value reaches a write transaction.
 */
interface PreparedTaskCreateBase {
  readonly repoId: string;
  readonly ownerUserId: string | null;
  readonly body: Readonly<CreateTaskBody>;
  readonly runtime: Runtime;
  readonly executionMode: ExecutionMode;
  readonly sandboxEnvironmentId: string | null;
  readonly model: string | null;
  readonly executionEnvironmentSnapshot: RuntimeExecutionEnvironmentSnapshot | null;
}

/**
 * Legacy fixtures may omit the discriminator. Durable acceptance cannot exist
 * without both immutable snapshots, so the type makes that state unrepresentable.
 */
export type PreparedTaskCreate = PreparedTaskCreateBase &
  (
    | {
        readonly admissionMode?: 'legacy';
        readonly resolvedBranch?: never;
        readonly resourceSnapshot?: never;
      }
    | {
        readonly admissionMode: 'durable-v2';
        readonly resolvedBranch: string;
        readonly resourceSnapshot: SandboxResourceSnapshot;
        /** Immutable provider policy selected before the acceptance write. */
        readonly workspaceMaterializationDeadlineMs: number;
      }
  );
