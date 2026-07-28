/**
 * The task-slot ceiling: its range, its validator, and how it resolves.
 *
 * This rule is shared by the two sides that would otherwise import each other —
 * `settings` validates a write against it before persisting, and `guardrails`
 * enforces it on the live semaphore. It lived inside `settings/settings-logic`,
 * so guardrails reached into settings for it and the two directories formed a
 * cycle. The rule belongs to neither: it belongs to the concurrency limit.
 */
import { DEFAULT_MAX_CONCURRENT_TASKS } from '@cap/contracts';

/**
 * Bounds of the contracts `MaxConcurrentTasksSchema`
 * (`z.number().int().min(1).max(20)`), mirrored here so the pure resolution
 * logic stays schema-free.
 */
export const MAX_CONCURRENT_TASKS_MIN = 1;
export const MAX_CONCURRENT_TASKS_MAX = 20;

/**
 * True when `value` is a slot ceiling the contracts schema accepts: an integer
 * in 1–20. Used as the service-side guard so an out-of-range/non-integer write
 * is rejected (400) BEFORE any mutation of the stored row or the live
 * semaphore (5.2).
 */
export function isValidMaxConcurrentTasks(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MAX_CONCURRENT_TASKS_MIN &&
    value <= MAX_CONCURRENT_TASKS_MAX
  );
}

/**
 * Resolves the effective SYSTEM-LEVEL slot ceiling for the settings READ shape
 * (5.1): `dbSetting ?? env MAX_CONCURRENT_TASKS ?? 5`.
 *
 *   - `stored` is the single `SystemSettings` row's value (`null`/`undefined`
 *     when no row has ever been persisted). Writes are contracts-validated to
 *     1–20, so a stored value outside that range (legacy/manual edit) is
 *     ignored defensively rather than thrown on read.
 *   - `envSeed` is the raw `MAX_CONCURRENT_TASKS` string, consulted ONLY when
 *     no row exists (first boot): any positive-integer string seeds the value
 *     (mirroring the guardrails construction seed), clamped into the contract
 *     range 1–20 so the READ shape stays schema-valid even when the env names
 *     a larger semaphore seed.
 *   - With neither, the default 5 applies.
 */
export function resolveMaxConcurrentTasks(
  stored: number | null | undefined,
  envSeed: string | undefined,
): number {
  if (isValidMaxConcurrentTasks(stored)) {
    return stored;
  }
  const parsed =
    envSeed === undefined || envSeed.trim() === '' ? Number.NaN : Number(envSeed);
  if (Number.isInteger(parsed) && parsed > 0) {
    return Math.min(
      Math.max(parsed, MAX_CONCURRENT_TASKS_MIN),
      MAX_CONCURRENT_TASKS_MAX,
    );
  }
  return DEFAULT_MAX_CONCURRENT_TASKS;
}
