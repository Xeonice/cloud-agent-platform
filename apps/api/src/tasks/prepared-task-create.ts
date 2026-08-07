import type {
  CreateTaskBody,
  Runtime,
  RuntimeExecutionEnvironmentSnapshot,
} from '@cap-console/contracts';
import type { ExecutionMode } from '@/agent-runtime/agent-runtime.port';
import type { SandboxResourceSnapshot } from '@cap-console/sandbox';

export type PreparedTaskAdmissionMode = 'durable-v2';

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
 * Acceptance cannot exist without both immutable snapshots, so the type makes
 * that state unrepresentable. The discriminator is no longer a choice — the
 * synchronous in-request pipeline it used to select is retired — but it is kept
 * as a required, single-valued field so a fixture that omits it fails to compile
 * rather than being silently accepted as some other kind of preparation.
 */
export type PreparedTaskCreate = PreparedTaskCreateBase & {
  readonly admissionMode: 'durable-v2';
  readonly resolvedBranch: string;
  readonly resourceSnapshot: SandboxResourceSnapshot;
  /** Immutable provider policy selected before the acceptance write. */
  readonly workspaceMaterializationDeadlineMs: number;
};
