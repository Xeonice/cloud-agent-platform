import {
  ForbiddenException,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import {
  CONSOLE_BUILD_ID_HEADER,
  compareConsoleBuild,
  describeConsoleBuildRefusal,
  resolveVersionResponse,
  type ConsoleBuildVerdict,
} from '@cap-console/contracts';

import type { AuthenticatedRequest } from '@/principal/authenticated-request';

/**
 * Refuses a console that is not the same build as this api.
 *
 * WHY AN IDENTITY AND NOT A COMPATIBILITY CHECK. The deployment invariant is that
 * the console and the api ship from ONE release: `release.yml` publishes the
 * images and the hosted console together, and `docker-compose.prod.yml` pins both
 * to one `CAP_VERSION`. Under that invariant "can these two talk" has no spectrum
 * — they are the same build or they are not — so this compares one value rather
 * than negotiating per-schema compatibility.
 *
 * It exists because the invariant was not holding. The hosted console was
 * published by a branch-tracking deploy on every merge while the api moved only at
 * a release; measured at the time, the newest tag sat 19 commits behind `main`
 * with ten of them touching the console or the shared contract. A wire shape moved
 * in between and the console's tolerance for the old one was deleted, so the
 * create-task dialog read an empty runtime list — with nothing anywhere reporting
 * why. That deployment path is closed now; this is the tripwire that says so if it
 * ever reopens.
 *
 * WHAT IS DELIBERATELY EXEMPT:
 *
 *  - **Machine credentials** (`api-key`, `mcp`). They reach `/v1` and the MCP
 *    surface, they are not a console, and they have no build to present. Applying
 *    this to them would refuse every programmatic client — which is why the scope
 *    is by PRINCIPAL KIND rather than by path: a path list would have to be kept
 *    in sync with the routes forever, and the first route someone forgets is the
 *    one that breaks a client.
 *  - **The legacy shared token** (`legacy-token`). It carries no account identity
 *    and is presented by scripts as readily as by a console, so a refusal could
 *    not be attributed. The deployment it serves is the single-machine compose
 *    stack, where the console and the api come from the same `CAP_VERSION` and
 *    cannot skew in the first place.
 *  - **An api that does not know its own version.** A source build reports
 *    `"unknown"`; refusing every console against it would break the ordinary
 *    development loop to enforce an invariant that only means anything between two
 *    DEPLOYED artifacts. {@link compareConsoleBuild} returns `api-unversioned` and
 *    this guard serves.
 *
 * ENFORCED BY DEFAULT, and that is a correction this design arrived at while being
 * built. The plan called for a three-step rollout — api reads, console sends, then
 * refusal is switched on — because an api that refuses a header no deployed
 * console sends refuses everything. That window was real when the two sides
 * deployed on different cadences. It no longer exists: the release now publishes
 * the console and the images together, so an api carrying this guard and a console
 * carrying the header arrive in the same release, already agreeing.
 *
 * {@link CONSOLE_BUILD_ENFORCED_ENV_VAR} therefore DISABLES rather than enables.
 * Refusing is the invariant; tolerating is the exception someone opts into, and an
 * escape hatch that has to be reached for is a different thing from a gate that
 * only works once somebody remembers to arm it. This programme has shipped the
 * second kind three times.
 */
@Injectable()
export class ConsoleBuildGuard implements CanActivate {
  private readonly logger = new Logger(ConsoleBuildGuard.name);

  /**
   * Whether a refusal is armed. Unset ⇒ armed.
   *
   * The escape hatch exists for a deployment that has genuinely diverged and needs
   * its console back to fix that — recovery, not a supported steady state. It is
   * OFF-by-value rather than on-by-value so that forgetting to set anything leaves
   * the invariant enforced.
   */
  private enforced(env: NodeJS.ProcessEnv): boolean {
    const raw = env[CONSOLE_BUILD_ENFORCED_ENV_VAR]?.trim().toLowerCase();
    return !(raw === '0' || raw === 'false');
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.operatorPrincipal;
    // Only a browser session is a console. Everything else is exempt by KIND —
    // see the class comment for why kind rather than path.
    if (principal?.kind !== 'session') return true;

    const presented = readPresentedBuild(request);
    const apiVersion = resolveVersionResponse(process.env).version;
    const verdict = compareConsoleBuild({ presented, apiVersion });
    if (verdict === 'match' || verdict === 'api-unversioned') return true;

    const detail = describeConsoleBuildRefusal({ verdict, presented, apiVersion });
    if (!this.enforced(process.env)) {
      // Observe-only. Logged at WARN because it is exactly the condition the
      // deployment coupling exists to make impossible; if this appears, the
      // coupling has a hole.
      this.logger.warn(
        `console build ${verdict}: ${detail ?? ''} (serving anyway — ` +
          `${CONSOLE_BUILD_ENFORCED_ENV_VAR} is disabling the refusal)`,
      );
      return true;
    }

    throw new ForbiddenException({
      error: consoleBuildErrorCode(verdict),
      message: detail,
      apiVersion,
      consoleBuild: presented ?? null,
    });
  }
}

/**
 * The env var that DISABLES the refusal. Unset means enforced.
 *
 * Named here rather than in the contracts package on purpose: it configures THIS
 * api process and no consumer reads it, so putting it in the shared package would
 * be an export nothing imports — the defect that package now has a gate for.
 */
export const CONSOLE_BUILD_ENFORCED_ENV_VAR = 'CAP_CONSOLE_BUILD_ENFORCED';

/** Reads the presented identity from the request headers, case-insensitively. */
function readPresentedBuild(request: AuthenticatedRequest): string | null {
  const raw = (request.headers as Record<string, unknown> | undefined)?.[
    CONSOLE_BUILD_ID_HEADER
  ];
  if (typeof raw === 'string') return raw;
  // A repeated header arrives as an array. Take the first rather than joining:
  // a joined value can never equal a version and would turn a duplicated header
  // into a mismatch, which is a different fault than the one being reported.
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return null;
}

/** A stable machine-readable code per refused verdict, for the console to branch on. */
function consoleBuildErrorCode(verdict: ConsoleBuildVerdict): string {
  return verdict === 'mismatch'
    ? 'console_build_mismatch'
    : 'console_build_unidentified';
}
