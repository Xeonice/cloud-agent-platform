import { z } from 'zod';

/**
 * Local-path repository import (add-repo-content-store / local-repo-import).
 *
 * These are CONSOLE-INTERNAL shapes: local import is an operator action on a
 * filesystem the api process can see, deliberately kept out of the public `/v1`
 * registry and the MCP tool surface. The feature is fail-closed — it exists only
 * when {@link LOCAL_REPO_IMPORT_ROOT_ENV} names an allowlist root.
 */

/** Env var whose value is the allowlist root. Unset/empty = feature disabled. */
export const LOCAL_REPO_IMPORT_ROOT_ENV = 'CAP_LOCAL_IMPORT_ROOT';

/**
 * Body of `POST /repos/local-import`.
 *
 * `path` is either an absolute path or a path relative to the configured root;
 * either way the server resolves it (realpath, symlinks followed) and requires
 * containment in the root. `name` is an optional display name — when omitted the
 * server derives it from the resolved directory name.
 */
export const LocalRepoImportRequestSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  name: z.string().trim().min(1).max(200).optional(),
});
export type LocalRepoImportRequest = z.infer<typeof LocalRepoImportRequestSchema>;

/**
 * Read-only capability probe for the console import dialog
 * (`GET /repos/local-import/availability`).
 *
 * When disabled, `root` is null and `envVar` names the configuration that would
 * enable it, so the console can either hide the mode or mark it unavailable with
 * the enabling configuration named — without guessing server configuration.
 */
export const LocalRepoImportAvailabilitySchema = z
  .object({
    enabled: z.boolean(),
    /** The configured allowlist root, or null when the feature is disabled. */
    root: z.string().min(1).nullable(),
    /** The environment variable that enables the feature. */
    envVar: z.literal(LOCAL_REPO_IMPORT_ROOT_ENV),
  })
  .strict();
export type LocalRepoImportAvailability = z.infer<
  typeof LocalRepoImportAvailabilitySchema
>;
