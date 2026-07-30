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

// ---------------------------------------------------------------------------
// Console ↔ api build identity (couple-console-deploy-to-the-release)
// ---------------------------------------------------------------------------

/**
 * The header a console attaches to every REST call, and the field it adds to the
 * WebSocket connect frame, naming the release it was built from.
 *
 * Why an identity and not a compatibility negotiation: the deployment invariant
 * is that the console and the api ship from ONE release. Under that invariant
 * "can these two talk" is not a question with a spectrum — they are the same
 * build or they are not, and a mismatch is a deployment defect rather than a
 * configuration to accommodate.
 *
 * It exists because the invariant was not holding. The hosted console was
 * published by a branch-tracking deploy on every merge while the api moved only
 * at a release, so the two ran different builds for most of their lives, and a
 * wire shape that changed in between produced an empty runtime list with nothing
 * anywhere reporting why.
 */
export const CONSOLE_BUILD_ID_HEADER = 'x-cap-console-build' as const;

// A `CONSOLE_BUILD_ID_ENV_VAR = 'VITE_BUILD_ID'` constant was written here and
// removed before it shipped: nothing imported it, because the name is spelled as
// a literal where it is actually needed — `apps/web/Dockerfile`'s ARG and
// `vite.config.ts`'s define, neither of which can import from this package. It
// was a fresh instance of the inline-literal restatement the previous change
// catalogued, created by the same reflex that produced the originals. The gate
// caught it in the same session it was written.

/**
 * The sentinel a console reports when it was built without a version.
 *
 * A LOCAL build legitimately has none — there is no release to name — so it keeps
 * working. A DEPLOYED console presenting this is a deployment that never received
 * its version, which is indistinguishable from a laptop build and is exactly how
 * one deployment path stayed unplumbed for its whole life while the other carried
 * a real version.
 */
export const CONSOLE_BUILD_ID_SENTINEL = 'dev' as const;

/** What the api concluded about a presented console identity. */
export const CONSOLE_BUILD_VERDICTS = [
  /** Identical to the api's own version. Serve. */
  'match',
  /** The console named a different release. Refuse; both versions are known. */
  'mismatch',
  /** The console named no release, or the sentinel. Refuse; only the api's is known. */
  'unidentified',
  /**
   * The api itself does not know its version — a source build with no build args.
   * Nothing can be asserted, so nothing is refused: a gate that fires when it
   * cannot tell is a gate that gets switched off.
   */
  'api-unversioned',
] as const;
export type ConsoleBuildVerdict = (typeof CONSOLE_BUILD_VERDICTS)[number];

/**
 * Compare a presented console identity against the api's own version.
 *
 * Pure, and shared by the REST guard, the WebSocket connect path and their tests,
 * so all three cannot disagree about what a mismatch is — the failure mode this
 * package exists to prevent.
 *
 * `api-unversioned` deliberately does NOT refuse. An api built from source with
 * no `CAP_VERSION` reports `"unknown"`, and refusing every console against it
 * would break the ordinary development loop to enforce an invariant that only
 * means anything between two DEPLOYED artifacts.
 */
export function compareConsoleBuild(input: {
  readonly presented: string | null | undefined;
  readonly apiVersion: string;
}): ConsoleBuildVerdict {
  const apiVersion = input.apiVersion.trim();
  if (apiVersion.length === 0 || apiVersion === UNKNOWN_VERSION_VALUE) {
    return 'api-unversioned';
  }
  const presented = input.presented?.trim() ?? '';
  if (presented.length === 0 || presented === CONSOLE_BUILD_ID_SENTINEL) {
    return 'unidentified';
  }
  return presented === apiVersion ? 'match' : 'mismatch';
}

/**
 * The operator-facing explanation for a refused verdict.
 *
 * Names BOTH sides when both are known, because the first question anyone asks is
 * which one is behind, and an error that does not answer it sends them to the
 * logs of whichever service they guessed.
 */
export function describeConsoleBuildRefusal(input: {
  readonly verdict: ConsoleBuildVerdict;
  readonly presented: string | null | undefined;
  readonly apiVersion: string;
}): string | null {
  if (input.verdict === 'match' || input.verdict === 'api-unversioned') {
    return null;
  }
  if (input.verdict === 'mismatch') {
    return (
      `This console was built from ${input.presented} and the api is running ` +
      `${input.apiVersion}. They ship from one release; upgrade whichever is behind.`
    );
  }
  return (
    `This console did not report which release it was built from, and the api is ` +
    `running ${input.apiVersion}. A deployed console is built by the release and ` +
    `carries its version; one that does not was published outside it.`
  );
}
