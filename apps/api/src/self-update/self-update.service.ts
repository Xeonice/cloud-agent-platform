import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import Docker from 'dockerode';

import { UpdateStatusService } from '../update-status/update-status.service';

/**
 * The env var that HARD-GATES self-update (self-update-action, design D1).
 *
 * Default OFF: unless this is an explicit truthy string the service REFUSES every
 * request, so merely shipping/deploying the change is INERT — no live host-root
 * upgrade capability exists until an operator deliberately enables it. Read at
 * REQUEST time (never captured at module load) so the gate reflects the live env.
 */
export const SELF_UPDATE_ENABLED_ENV = 'SELF_UPDATE_ENABLED';

/**
 * The compose files the bounded updater LAYERS (the second `-f` wins). Fixed
 * server-side literals — never client input — so the updater can only run the
 * documented cap compose topology with the GHCR image override on top
 * (`docker-compose.images.yml` pins all three cap services to one `CAP_VERSION`).
 */
export const COMPOSE_FILES: readonly string[] = [
  'docker-compose.yml',
  'docker-compose.images.yml',
];

/**
 * The ONLY compose services the updater pulls + recreates (design D3 — bounded
 * to the cap namespace + services). These are exactly the three services
 * `docker-compose.images.yml` re-points to the matched `ghcr.io/xeonice/cap-*`
 * release set: the api, the web console, and the per-task AIO sandbox image
 * vehicle. Scoping the `pull`/`up -d` to this fixed list means the updater can
 * NEVER touch postgres / loki / grafana / nginx or any non-cap unit.
 */
export const CAP_SERVICES: readonly string[] = ['api', 'web', 'aio-sandbox-image'];

/** The compose project env var the image override interpolates as the single pin. */
export const CAP_VERSION_ENV = 'CAP_VERSION';

/**
 * The image the detached one-shot updater runs (a compose-capable helper). It is
 * a fixed server-side literal — never derived from the request — overridable for
 * an operator whose host stages a different compose image via
 * `SELF_UPDATE_UPDATER_IMAGE`. The updater container mounts the host docker socket
 * + the compose project dir so it can `docker compose` the cap stack after the
 * api (its own caller) goes down.
 */
export const DEFAULT_UPDATER_IMAGE = 'docker:27-cli';
export const UPDATER_IMAGE_ENV = 'SELF_UPDATE_UPDATER_IMAGE';

/**
 * The host path of the compose project (where `docker-compose.yml` lives), bind-
 * mounted into the updater so `docker compose -f ...` resolves the files. Defaults
 * to `/srv/cap` (the documented compose deploy root) and is overridable per host.
 */
export const DEFAULT_COMPOSE_PROJECT_DIR = '/srv/cap';
export const COMPOSE_PROJECT_DIR_ENV = 'SELF_UPDATE_COMPOSE_DIR';

/**
 * A bounded, validated upgrade PLAN — the inspectable description of exactly what
 * the detached updater will do. Pure data with no arbitrary image/tag/command: a
 * fixed compose-file layering, the fixed cap service list, and the single
 * `CAP_VERSION=<target>` pin. The verify/unit tests assert THIS rather than
 * actually recreating anything.
 */
export interface UpdatePlan {
  /** The validated semver target tag (matches `/update-status`'s latest). */
  readonly target: string;
  /** The compose `-f` files the updater layers (fixed). */
  readonly composeFiles: readonly string[];
  /** The cap-only services the updater pulls + recreates (fixed). */
  readonly services: readonly string[];
  /**
   * The two ordered shell commands the detached updater runs: `pull` FIRST, then
   * `up -d` — so a failed pull leaves the prior version running (design D4,
   * pull-then-recreate). Each is the full `docker compose -f ... -f ... <verb>
   * <cap services>` argv, scoped to the cap services only.
   */
  readonly commands: readonly string[];
  /** The single shell line the detached updater executes (`pull && up -d`). */
  readonly script: string;
}

/**
 * Launches the prepared {@link UpdatePlan} as a DETACHED updater that OUTLIVES the
 * api's own restart (design D4). Injected behind a port so the unit tests assert
 * the constructed plan WITHOUT actually creating a container / recreating the
 * stack. The live implementation ({@link DockerUpdaterLauncher}) creates a one-
 * shot helper container over the existing docker access.
 */
export const UPDATER_LAUNCHER = Symbol('SELF_UPDATE_UPDATER_LAUNCHER');
export interface UpdaterLauncher {
  launch(plan: UpdatePlan): Promise<void>;
}

/** Why a self-update request was refused — surfaced to the controller for status mapping. */
export type SelfUpdateRefusal =
  /** `SELF_UPDATE_ENABLED` is not truthy → the feature is inert (404/refuse). */
  | 'disabled'
  /** The target is not a valid semver tag, or no target was supplied. */
  | 'invalid-target'
  /** The target does not match `/update-status`'s latest (or no update available). */
  | 'target-mismatch';

export class SelfUpdateRefusedError extends Error {
  constructor(readonly reason: SelfUpdateRefusal, message: string) {
    super(message);
    this.name = 'SelfUpdateRefusedError';
  }
}

/**
 * Self-update service (self-update-action, design D1/D3/D4). The most dangerous
 * surface in the OSS self-update epic — a host-root container op behind a button —
 * so it is dominated by CONTAINMENT:
 *
 *   - D1 HARD ENV GATE, default OFF: every request is REFUSED unless
 *     `SELF_UPDATE_ENABLED` is truthy. Shipping is inert.
 *   - D3 BOUNDED TARGET, no arbitrary input: the target MUST be a valid semver tag
 *     that MATCHES the latest version the cached {@link UpdateStatusService}
 *     reports (a server-side cross-check). The updater pulls ONLY the cap GHCR
 *     namespace (`docker-compose.images.yml` → `ghcr.io/xeonice/cap-*:<target>`)
 *     and recreates ONLY the {@link CAP_SERVICES}. There is NO path to an
 *     arbitrary image, tag, or command.
 *   - D4 DETACHED SELF-RECREATE: the api cannot cleanly `compose up` its own
 *     container while running, so an enabled+validated request launches a DETACHED
 *     one-shot updater (the same `new Docker()` docker.sock idiom the
 *     AioSandboxProvider uses) that runs compose `pull` THEN `up -d` and OUTLIVES
 *     the api's restart. The endpoint acks "update started" BEFORE the api goes
 *     down; `survive-api-redeploy` keeps in-flight tasks alive and the console
 *     reconnects via WS auto-reconnect. Pull-then-recreate ordering means a failed
 *     pull leaves the prior version running.
 */
@Injectable()
export class SelfUpdateService {
  private readonly log = new Logger(SelfUpdateService.name);
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly updateStatus: UpdateStatusService,
    @Optional() @Inject(UPDATER_LAUNCHER) private readonly launcher?: UpdaterLauncher,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.env = env;
  }

  /**
   * Whether self-update is enabled (`SELF_UPDATE_ENABLED` truthy). Read at call
   * time so the default-OFF gate reflects the live env. Mirrors the legacy-token
   * env convention (`true`/`1`/`yes`, case-insensitive).
   */
  isEnabled(): boolean {
    const raw = this.env[SELF_UPDATE_ENABLED_ENV];
    if (typeof raw !== 'string') {
      return false;
    }
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }

  /**
   * Validate + build the bounded {@link UpdatePlan} for `target`, WITHOUT launching
   * anything. Throws a {@link SelfUpdateRefusedError} when:
   *   - the feature is disabled (`disabled`);
   *   - `target` is missing / not a valid semver tag (`invalid-target`);
   *   - `target` does not match the latest version `/update-status` reports, or no
   *     update is available (`target-mismatch`).
   * Pure with respect to env + the cached update-status lookup; the controller
   * acks AFTER this resolves (so a refusal never acks "update started").
   */
  async planUpdate(target: string): Promise<UpdatePlan> {
    if (!this.isEnabled()) {
      throw new SelfUpdateRefusedError(
        'disabled',
        'self-update is disabled (SELF_UPDATE_ENABLED is not set)',
      );
    }

    const normalized = typeof target === 'string' ? target.trim() : '';
    if (normalized.length === 0 || !isSemverTag(normalized)) {
      throw new SelfUpdateRefusedError(
        'invalid-target',
        `self-update target is not a valid version tag: ${JSON.stringify(target)}`,
      );
    }

    // Server-side cross-check (design D3): the target MUST equal the latest
    // version the cached /update-status reports AND an update must be available.
    // No arbitrary version can be forced; client input is only ever a confirmation
    // of what the server already determined is the upgrade.
    const status = await this.updateStatus.getStatus();
    if (
      !status.updateAvailable ||
      status.latestVersion === null ||
      !versionsMatch(normalized, status.latestVersion)
    ) {
      throw new SelfUpdateRefusedError(
        'target-mismatch',
        `self-update target ${normalized} does not match the latest available version ` +
          `${status.latestVersion ?? '(none)'} reported by /update-status`,
      );
    }

    return this.buildPlan(status.latestVersion);
  }

  /**
   * Validate + launch the detached updater for `target` (design D4). Builds the
   * bounded plan via {@link planUpdate} (which enforces the gate + validation +
   * cross-check), then hands it to the injected {@link UpdaterLauncher} which
   * launches a DETACHED one-shot updater that pulls THEN recreates the cap
   * services and outlives the api's own restart. Returns the launched plan so the
   * controller can ack what it started. Refuses (throws {@link
   * SelfUpdateRefusedError}) BEFORE any launch on a disabled / invalid /
   * mismatched request.
   */
  async requestUpdate(target: string): Promise<UpdatePlan> {
    const plan = await this.planUpdate(target);
    const launcher = this.launcher ?? new DockerUpdaterLauncher(this.env);
    this.log.warn(
      `self-update: launching DETACHED updater to ${plan.target} ` +
        `(pull then up -d for cap services [${plan.services.join(', ')}]) — ` +
        `the api will be recreated; running tasks survive via survive-api-redeploy`,
    );
    await launcher.launch(plan);
    return plan;
  }

  /**
   * Construct the bounded {@link UpdatePlan} for a validated `target`. The compose
   * files + service list are fixed server-side literals; the ONLY interpolated
   * value is the validated `CAP_VERSION=<target>` pin. `pull` is ordered BEFORE
   * `up -d` so a failed pull leaves the prior version running (design D4).
   */
  private buildPlan(target: string): UpdatePlan {
    const fileArgs = COMPOSE_FILES.flatMap((f) => ['-f', f]);
    const services = [...CAP_SERVICES];
    // `docker compose -f docker-compose.yml -f docker-compose.images.yml <verb> <cap services>`.
    const pull = ['docker', 'compose', ...fileArgs, 'pull', ...services].join(' ');
    const up = ['docker', 'compose', ...fileArgs, 'up', '-d', ...services].join(' ');
    return {
      target,
      composeFiles: [...COMPOSE_FILES],
      services,
      commands: [pull, up],
      // Pull THEN recreate; `&&` so a failed pull never reaches `up -d`.
      script: `${pull} && ${up}`,
    };
  }
}

/**
 * Strict semver-tag validator for the upgrade target (design D3 — no arbitrary
 * tag). Accepts an optional leading `v`, a `major.minor.patch` core, and an
 * optional `-prerelease` / `+build` suffix of dot-separated alphanumeric/hyphen
 * identifiers. Rejects anything else (a moving tag like `latest`, a bare branch,
 * a shell metacharacter, an arbitrary image ref) so the target can ONLY ever be a
 * release version that the `/update-status` cross-check then further bounds.
 */
export function isSemverTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag);
}

/**
 * Whether two version tags refer to the same release, tolerant ONLY of a leading
 * `v` (so `v1.2.3` from the client matches `1.2.3` from a GitHub tag and vice
 * versa). Deliberately NOT a semver-precedence compare — the target must be the
 * EXACT latest, not merely "≥" it.
 */
function versionsMatch(a: string, b: string): boolean {
  const strip = (s: string): string => (s[0] === 'v' || s[0] === 'V' ? s.slice(1) : s);
  return strip(a.trim()) === strip(b.trim());
}

/**
 * Live {@link UpdaterLauncher}: creates + starts a DETACHED one-shot helper
 * container (same `new Docker()` docker.sock idiom as {@link AioSandboxProvider})
 * that runs the bounded compose `pull && up -d` script. The container mounts the
 * host docker socket and the compose project dir, runs on the host network (so it
 * can reach the docker daemon + registries while the api goes down), and
 * `AutoRemove`s itself when done. Because it is its OWN container, it OUTLIVES the
 * api's recreate — the api can be torn down + recreated by `up -d` while this
 * helper keeps running.
 */
export class DockerUpdaterLauncher implements UpdaterLauncher {
  private readonly docker = new Docker();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async launch(plan: UpdatePlan): Promise<void> {
    const image = nonEmptyEnv(this.env[UPDATER_IMAGE_ENV]) ?? DEFAULT_UPDATER_IMAGE;
    const projectDir =
      nonEmptyEnv(this.env[COMPOSE_PROJECT_DIR_ENV]) ?? DEFAULT_COMPOSE_PROJECT_DIR;
    // The single pin every cap service resolves `${CAP_VERSION}` to.
    const containerEnv = [`${CAP_VERSION_ENV}=${plan.target}`];

    const container = await this.docker.createContainer({
      Image: image,
      // The bounded script: compose pull THEN up -d, cap services only. `-c`
      // takes a single string; the script is built ENTIRELY from server-side
      // literals + the validated target, so there is no injection surface.
      Cmd: ['sh', '-c', plan.script],
      Env: containerEnv,
      WorkingDir: projectDir,
      HostConfig: {
        // One-shot: clean itself up once the recreate finishes.
        AutoRemove: true,
        // Host network so it reaches the docker daemon + registries even as the
        // api (and its cap-net) is recreated underneath it.
        NetworkMode: 'host',
        Binds: [
          // The host docker socket — the existing docker access this whole stack
          // already relies on (the trust boundary is the host, per the product
          // model). The updater needs it to `docker compose` the cap stack.
          '/var/run/docker.sock:/var/run/docker.sock',
          // The compose project dir, so `-f docker-compose*.yml` resolves.
          `${projectDir}:${projectDir}`,
        ],
      },
    });
    // DETACHED: start and return. The helper container outlives THIS api process
    // when `up -d` recreates the api container; we do not wait on it.
    await container.start();
  }
}

/** A trimmed non-empty string, or `null` for undefined/blank. */
function nonEmptyEnv(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length === 0 ? null : t;
}
