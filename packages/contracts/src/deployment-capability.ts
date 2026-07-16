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
