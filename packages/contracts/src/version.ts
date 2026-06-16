import { z } from 'zod';

/**
 * Build-version contract (versioned-release-pipeline, Phase 1 of the OSS
 * self-update epic).
 *
 * The api exposes an UNAUTHENTICATED `GET /version` endpoint (a sibling of
 * `/health` — see design D1) that reports only build metadata and carries NO
 * secrets. Each field is read from a build-time-injected environment value
 * (`CAP_VERSION` / `GIT_SHA` / `BUILD_TIME`, declared as `ARG`→`ENV` in the api
 * Dockerfile) and SHALL fall back to the sentinel {@link UNKNOWN_VERSION_VALUE}
 * (`"unknown"`) when not provided — so a plain source build (no build args)
 * reports HONESTLY rather than failing.
 *
 * This is the version SUBSTRATE the later update-check (Phase 2) and one-click
 * upgrade (Phase 3) consume: a published `cap-api:vX.Y.Z` image self-reports
 * `version === 'vX.Y.Z'` via this endpoint.
 */

/**
 * The sentinel reported for any build-metadata field that was not injected at
 * build time. A source build with no version build args reports this for every
 * field rather than erroring.
 */
export const UNKNOWN_VERSION_VALUE = 'unknown' as const;

/**
 * The environment-variable names the api reads its build metadata from. These
 * are injected by the api Dockerfile (`ARG`→`ENV`) and, in turn, by the release
 * workflow's `docker/build-push-action` build args. Each is OPTIONAL at runtime;
 * an absent value degrades to {@link UNKNOWN_VERSION_VALUE}.
 */
export const VERSION_ENV_VARS = {
  /** The user-facing cap version — the Release tag `vX.Y.Z` for a CI build. */
  version: 'CAP_VERSION',
  /** The git commit SHA the image was built from. */
  gitSha: 'GIT_SHA',
  /** The image build timestamp (ISO 8601, set by the build). */
  buildTime: 'BUILD_TIME',
} as const;

/**
 * The `GET /version` response body. All three fields are non-empty strings; an
 * un-injected field is the literal sentinel {@link UNKNOWN_VERSION_VALUE} rather
 * than empty/null, so the shape is uniform whether or not the build injected
 * version metadata.
 */
export const VersionResponseSchema = z.object({
  /** The user-facing cap version (`CAP_VERSION`), or `"unknown"`. */
  version: z.string().min(1),
  /** The git commit SHA the build was cut from (`GIT_SHA`), or `"unknown"`. */
  gitSha: z.string().min(1),
  /** The image build timestamp (`BUILD_TIME`), or `"unknown"`. */
  buildTime: z.string().min(1),
});
export type VersionResponse = z.infer<typeof VersionResponseSchema>;

/**
 * Builds a {@link VersionResponse} from a process-environment-like record,
 * applying the honest `"unknown"` fallback per field. Pure (no `process`
 * reference) so it is trivially testable and shared between the api handler and
 * its test. A value that is present but empty/whitespace is treated as absent.
 */
export function resolveVersionResponse(
  env: Record<string, string | undefined>,
): VersionResponse {
  const read = (name: string): string => {
    const raw = env[name];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw;
    }
    return UNKNOWN_VERSION_VALUE;
  };
  return VersionResponseSchema.parse({
    version: read(VERSION_ENV_VARS.version),
    gitSha: read(VERSION_ENV_VARS.gitSha),
    buildTime: read(VERSION_ENV_VARS.buildTime),
  });
}
