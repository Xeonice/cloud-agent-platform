import { z } from 'zod';

/** Secret-free identifier grammar shared by deployment capability attestations. */
export const DeploymentCapabilitySafeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:@/+-]+$/u);

/** Common process-report fields; capability-specific contracts add a role enum. */
export const DeploymentCapabilityLocalReportFields = {
  schemaVersion: z.literal(1),
  instanceId: DeploymentCapabilitySafeTextSchema,
  buildIdentity: DeploymentCapabilitySafeTextSchema,
  capabilities: z.array(DeploymentCapabilitySafeTextSchema).max(64),
  ready: z.boolean(),
  reportedAt: z.string().datetime({ offset: true }),
} as const;

// ---------------------------------------------------------------------------
// Task provisioning transfer-progress emission gate (detach-workspace-clone D6)
// ---------------------------------------------------------------------------

/**
 * Deployment capability naming the additive nullable transfer-progress object
 * on the strict `TaskProvisioningSummary` schema. Because the summary schema is
 * `.strict()`, a reader built before the progress field exists rejects any
 * payload that carries it; emission therefore follows the deployment
 * capability-gate discipline for mixed-version rollout, and a rollback closes
 * this gate before downgrading the API.
 */
export const TASK_PROVISIONING_PROGRESS_CAPABILITY =
  'task-provisioning-progress.v1';

/**
 * Rollout switch for {@link TASK_PROVISIONING_PROGRESS_CAPABILITY}. Closed
 * unless explicitly opened (`1`/`true`), matching the fail-closed discipline of
 * the other deployment capability gates: while closed, task responses omit the
 * progress object and stay parseable by strict pre-progress readers.
 */
export const TASK_PROVISIONING_PROGRESS_ENABLED_ENV =
  'CAP_TASK_PROVISIONING_PROGRESS_ENABLED';

/**
 * Pure environment evaluation of the progress-emission gate. Reading the
 * environment is deliberately the only input: closing the gate (unset/`0`/
 * `false`) must always win, including mid-rollback, without consulting any
 * mutable deployment state.
 */
export function isTaskProvisioningProgressEmissionOpen(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const normalized = env[TASK_PROVISIONING_PROGRESS_ENABLED_ENV]
    ?.trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true';
}
