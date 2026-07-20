import os from 'node:os';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import Docker from 'dockerode';

import { UpdateStatusService } from '../update-status/update-status.service';
import {
  SANDBOX_ENVIRONMENT_CONTRACT_VERSION,
  type SandboxEnvironmentsService,
} from '../sandbox-environments/sandbox-environments.service';

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
 * FALLBACK compose files the updater layers when the running topology CANNOT be
 * auto-detected from the api's own container labels (a non-compose run). The
 * PRIMARY path derives the `-f` files from `com.docker.compose.project.config_files`
 * (self-update-resident-topology), so the updater targets whatever stack is actually
 * running. Overridable for the fallback via `SELF_UPDATE_COMPOSE_FILES`.
 */
export const COMPOSE_FILES: readonly string[] = [
  'docker-compose.yml',
  'docker-compose.images.yml',
];

/**
 * FALLBACK declared cap services when the topology cannot be auto-detected — split
 * by {@link resolveServiceSets} into the recreate set (running-equivalent: api/web)
 * and the pull set (those PLUS the never-starts pull-only stager `aio-sandbox-image`).
 * The PRIMARY path derives the RUNNING cap services from the project's containers
 * (`ghcr.io/<owner>/cap-*` images), then likewise adds the declared pull-only cap
 * services to the pull set — so it targets exactly the cap units the deployment runs
 * plus the sandbox image to stage, never postgres/loki/grafana. Overridable for the
 * fallback via `SELF_UPDATE_SERVICES` (comma-separated).
 */
export const CAP_SERVICES: readonly string[] = ['api', 'web', 'aio-sandbox-image'];

/**
 * Never-starts, PULL-ONLY cap services: declared by the compose project (so their
 * image must be pulled at the target version) but having NO running container, so
 * they are unobservable from running state and CANNOT be derived from the container
 * listing. `aio-sandbox-image` is the architecture's fixed sandbox-image stager
 * (`entrypoint: ["true"]`, `restart: "no"`) — its only purpose is to make
 * `docker compose pull` stage `cap-aio-sandbox:<target>` onto the host for the DooD
 * sandbox provider. Members are added to the PULL set but NEVER the recreate set.
 * Operator-overridable via `SELF_UPDATE_PULL_ONLY_SERVICES` (comma-separated; empty
 * to disable). Every entry is a cap service, so the pull set stays cap-scoped.
 */
export const PULL_ONLY_CAP_SERVICES: readonly string[] = ['aio-sandbox-image'];
export const PULL_ONLY_SERVICES_ENV = 'SELF_UPDATE_PULL_ONLY_SERVICES';

/** Sandbox image delivery mode persisted by quick-deploy / operator env. */
export const SANDBOX_IMAGE_DELIVERY_ENV = 'CAP_SANDBOX_IMAGE_DELIVERY';
export const SANDBOX_PROVIDER_ENV = 'CAP_SANDBOX_PROVIDER';
export const SANDBOX_ASSET_DIR_ENV = 'CAP_SANDBOX_ASSET_DIR';
export const RELEASES_REPO_ENV = 'GITHUB_RELEASES_REPO';
export const RELEASE_ASSET_BASE_ENV = 'CAP_RELEASE_ASSET_BASE';
export const BOXLITE_ROOTFS_PATH_ENV = 'BOXLITE_ROOTFS_PATH';
export const BOXLITE_ROOTFS_PATH_MAP_ENV = 'BOXLITE_ROOTFS_PATH_MAP';
export const BOXLITE_IMAGE_ENV = 'BOXLITE_IMAGE';
export const BOXLITE_IMAGE_MAP_ENV = 'BOXLITE_IMAGE_MAP';
export const BOXLITE_PROTOCOL_MODE_ENV = 'BOXLITE_PROTOCOL_MODE';
export const AIO_PULL_ONLY_SERVICE = 'aio-sandbox-image';

/**
 * Optional override for the sandbox environment contract expected by the target
 * release. Normal releases use the code-owned
 * {@link SANDBOX_ENVIRONMENT_CONTRACT_VERSION}; tests and future release metadata
 * plumbing can set this to simulate a target that requires a newer validation
 * contract before the new api container starts.
 */
export const SANDBOX_ENVIRONMENT_TARGET_CONTRACT_ENV =
  'CAP_SANDBOX_ENVIRONMENT_CONTRACT_VERSION';

/** The `ghcr.io/<owner>/cap-*` namespace that marks a service as a cap unit to upgrade. */
const CAP_IMAGE_RE = /(^|\/)ghcr\.io\/[^/]+\/cap-[^/:@\s]+/i;

/** The compose project env var the image override interpolates as the single pin. */
export const CAP_VERSION_ENV = 'CAP_VERSION';

/**
 * The image the detached one-shot updater runs (a compose-capable helper). It is
 * a fixed server-side literal — never derived from the request — overridable for
 * an operator whose host stages a different compose image via
 * `SELF_UPDATE_UPDATER_IMAGE`. The official `docker:*-cli` images bundle the compose
 * v2 plugin (verified `docker:27-cli` → compose v2.33.0); the updater script also
 * idempotently ensures it, so compose is guaranteed regardless of tag.
 */
export const DEFAULT_UPDATER_IMAGE = 'docker:27-cli';
export const UPDATER_IMAGE_ENV = 'SELF_UPDATE_UPDATER_IMAGE';

/**
 * The host path of the compose project (where the compose file lives), used ONLY as
 * the FALLBACK working dir when the topology cannot be auto-detected from the api's
 * own container `com.docker.compose.project.working_dir` label. Defaults to the
 * documented compose deploy root and is overridable via `SELF_UPDATE_COMPOSE_DIR`.
 */
export const DEFAULT_COMPOSE_PROJECT_DIR = '/srv/cap';
export const COMPOSE_PROJECT_DIR_ENV = 'SELF_UPDATE_COMPOSE_DIR';

/** Fallback-only env overrides (used when topology auto-detection fails). */
export const COMPOSE_FILES_ENV = 'SELF_UPDATE_COMPOSE_FILES';
export const COMPOSE_PROJECT_NAME_ENV = 'SELF_UPDATE_PROJECT';
export const SERVICES_ENV = 'SELF_UPDATE_SERVICES';

/**
 * The compose topology the updater acts on — DERIVED from the running deployment
 * (self-update-resident-topology) rather than fixed source-overlay literals, so the
 * upgrade keys to whatever stack is actually running (the source compose, the images
 * overlay, or the resident `docker-compose.prod.yml`).
 */
export interface UpdateTopology {
  /** The compose project name (`-p`), or '' when none (compose default). */
  readonly project: string;
  /** The compose `-f` file(s) (absolute paths from the running deployment). */
  readonly composeFiles: readonly string[];
  /** The working dir the updater runs in / bind-mounts (where the `.env` lives). */
  readonly workingDir: string;
  /**
   * The RECREATE set: the RUNNING cap services (ghcr cap-* images) to `up -d`. A
   * never-starts pull-only service is NOT here (it is staged, not recreated).
   */
  readonly services: readonly string[];
  /**
   * The PULL set: every cap service whose image must be staged at the target —
   * `services` PLUS the declared never-starts pull-only cap services (e.g.
   * `aio-sandbox-image`), which have no container and so cannot be derived from
   * running state. Strictly cap-scoped. Used for `compose pull`.
   */
  readonly pullServices: readonly string[];
}

/**
 * Resolves the {@link UpdateTopology} of the RUNNING deployment. Injected behind a
 * port so the unit tests supply a deterministic topology WITHOUT docker. The live
 * implementation ({@link DockerTopologyResolver}) reads the api's own container
 * compose labels; returns `null` when the api was not run via compose (no labels),
 * so the service can fall back to operator env / documented literals.
 */
export const TOPOLOGY_RESOLVER = Symbol('SELF_UPDATE_TOPOLOGY_RESOLVER');
export interface TopologyResolver {
  resolve(): Promise<UpdateTopology | null>;
}

/**
 * A bounded, validated upgrade PLAN — the inspectable description of exactly what
 * the detached updater will do. Pure data with no arbitrary image/tag/command: the
 * derived compose topology (project + files + working dir), the cap-only service
 * list, and the single `CAP_VERSION=<target>` pin. The verify/unit tests assert
 * THIS rather than actually recreating anything.
 */
export interface UpdatePlan {
  /** The validated semver target tag (matches `/update-status`'s latest). */
  readonly target: string;
  /** The compose project name the updater scopes to (`-p`), or '' for the default. */
  readonly project: string;
  /** The compose `-f` files the updater layers (derived from the running deployment). */
  readonly composeFiles: readonly string[];
  /** The dir the updater runs in + bind-mounts (where `.env` is rewritten). */
  readonly workingDir: string;
  /** The RECREATE set: running cap services the updater `up -d`s (derived from cap-* images). */
  readonly services: readonly string[];
  /** The PULL set: `services` plus declared never-starts pull-only cap services; `compose pull`ed. */
  readonly pullServices: readonly string[];
  /**
   * The two ordered compose commands: `pull` FIRST, then `up -d` — so a failed pull
   * leaves the prior version running (design D4). Each is the full
   * `docker compose -p <project> -f <files…> <verb> <cap services>` argv.
   */
  readonly commands: readonly string[];
  /**
   * The single shell line the detached updater executes: ensure the compose plugin,
   * persist the `CAP_VERSION` pin into `.env` (so the upgrade sticks across a later
   * manual `up`), then `pull && up -d`.
   */
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
  | 'target-mismatch'
  /** The running topology resolves no cap-* service to upgrade (operator misconfig). */
  | 'no-cap-service';

export class SelfUpdateRefusedError extends Error {
  constructor(readonly reason: SelfUpdateRefusal, message: string) {
    super(message);
    this.name = 'SelfUpdateRefusedError';
  }
}

/**
 * Self-update service (self-update-action, design D1/D3/D4; topology auto-detect per
 * self-update-resident-topology). The most dangerous surface in the OSS self-update
 * epic — a host-root container op behind a button — so it is dominated by CONTAINMENT:
 *
 *   - D1 HARD ENV GATE, default OFF: every request is REFUSED unless
 *     `SELF_UPDATE_ENABLED` is truthy. Shipping is inert.
 *   - D3 BOUNDED TARGET, no arbitrary input: the target MUST be a valid semver tag
 *     that MATCHES the latest version the cached {@link UpdateStatusService}
 *     reports (a server-side cross-check). The updater pulls ONLY the cap GHCR
 *     namespace and recreates ONLY the cap services — DERIVED from the running
 *     deployment's compose labels (cap services = `ghcr.io/<owner>/cap-*` images),
 *     never from the request. There is NO path to an arbitrary image/tag/command.
 *   - D4 DETACHED SELF-RECREATE: an enabled+validated request launches a DETACHED
 *     one-shot updater that runs compose `pull` THEN `up -d` (scoped to the derived
 *     cap services) and OUTLIVES the api's restart, and PERSISTS the new
 *     `CAP_VERSION` into the deployment `.env` so the upgrade sticks. The endpoint
 *     acks "update started" BEFORE the api goes down; `survive-api-redeploy` keeps
 *     in-flight tasks alive and the console reconnects via WS auto-reconnect.
 */
@Injectable()
export class SelfUpdateService {
  private readonly log = new Logger(SelfUpdateService.name);
  private readonly env: NodeJS.ProcessEnv;
  private readonly topologyResolver: TopologyResolver;

  constructor(
    private readonly updateStatus: UpdateStatusService,
    @Optional() @Inject(UPDATER_LAUNCHER) private readonly launcher?: UpdaterLauncher,
    env: NodeJS.ProcessEnv = process.env,
    @Optional() @Inject(TOPOLOGY_RESOLVER) topologyResolver?: TopologyResolver,
    @Optional()
    private readonly sandboxEnvironments?: Pick<
      SandboxEnvironmentsService,
      'markCustomEnvironmentsStale'
    >,
  ) {
    this.env = env;
    this.topologyResolver = topologyResolver ?? new DockerTopologyResolver(env);
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
   *     update is available (`target-mismatch`);
   *   - the resolved topology has no cap-* service to upgrade (`no-cap-service`).
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

    // Server-side cross-check (design D3): the target MUST equal the latest version
    // the cached /update-status reports AND an update must be available.
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

    // Derive the topology of the RUNNING deployment from the api's own compose
    // labels; fall back to operator env / documented literals only when the api was
    // not run via compose (no labels).
    const detected = await this.topologyResolver.resolve();
    const topology = detected ?? this.fallbackTopology();
    if (topology.services.length === 0) {
      throw new SelfUpdateRefusedError(
        'no-cap-service',
        `self-update found no cap (ghcr.io/*/cap-*) service to upgrade in compose project ` +
          `${topology.project || '(default)'} — nothing to recreate`,
      );
    }

    return this.buildPlan(status.latestVersion, topology);
  }

  /**
   * Validate + launch the detached updater for `target` (design D4). Builds the
   * bounded plan via {@link planUpdate} (which enforces the gate + validation +
   * cross-check + topology resolution), then hands it to the injected {@link
   * UpdaterLauncher}. Returns the launched plan so the controller can ack what it
   * started. Refuses BEFORE any launch on a disabled / invalid / mismatched / no-cap
   * request.
   */
  async requestUpdate(target: string): Promise<UpdatePlan> {
    const plan = await this.planUpdate(target);
    const launcher = this.launcher ?? new DockerUpdaterLauncher(this.env);
    const staleCount = await this.markStaleSandboxEnvironmentsForTarget();
    this.log.warn(
      `self-update: launching DETACHED updater to ${plan.target} in ${plan.workingDir} ` +
        `(pull cap services [${plan.pullServices.join(', ')}] then up -d [${plan.services.join(', ')}] ` +
        `of project ${plan.project || '(default)'}) — the api will be recreated; running tasks survive ` +
        `via survive-api-redeploy`,
    );
    if (staleCount > 0) {
      this.log.warn(
        `self-update: marked ${staleCount} custom sandbox environment(s) stale ` +
          `for contract ${this.targetSandboxEnvironmentContractVersion()}`,
      );
    }
    await launcher.launch(plan);
    return plan;
  }

  private async markStaleSandboxEnvironmentsForTarget(): Promise<number> {
    if (!this.sandboxEnvironments) return 0;
    return this.sandboxEnvironments.markCustomEnvironmentsStale(
      this.targetSandboxEnvironmentContractVersion(),
    );
  }

  private targetSandboxEnvironmentContractVersion(): string {
    return (
      nonEmptyEnv(this.env[SANDBOX_ENVIRONMENT_TARGET_CONTRACT_ENV]) ??
      SANDBOX_ENVIRONMENT_CONTRACT_VERSION
    );
  }

  /**
   * The FALLBACK topology when the api's own container exposes no compose labels:
   * operator env overrides, else the documented source-overlay literals.
   */
  private fallbackTopology(): UpdateTopology {
    const project = nonEmptyEnv(this.env[COMPOSE_PROJECT_NAME_ENV]) ?? '';
    const composeFiles =
      parseList(this.env[COMPOSE_FILES_ENV]) ?? [...COMPOSE_FILES];
    const workingDir =
      nonEmptyEnv(this.env[COMPOSE_PROJECT_DIR_ENV]) ?? DEFAULT_COMPOSE_PROJECT_DIR;
    // The declared cap services (operator override else the documented set, which
    // already lists `aio-sandbox-image`); split into recreate (api/web) + pull
    // (those plus the pull-only sandbox stager) so the fallback stages the sandbox
    // image just like the primary path.
    const declared = parseList(this.env[SERVICES_ENV]) ?? [...CAP_SERVICES];
    const { services, pullServices } = resolveServiceSets(declared, this.env);
    return { project, composeFiles, workingDir, services, pullServices };
  }

  /**
   * Construct the bounded {@link UpdatePlan} for a validated `target` + resolved
   * topology. The ONLY interpolated values are the derived topology (from server-side
   * Docker labels, never the request) and the validated `CAP_VERSION=<target>` pin.
   * The script: (1) ensure the compose plugin, (2) persist the pin into `.env`
   * atomically, (3) `pull` THEN (4) `up -d` — pull before recreate so a failed pull
   * leaves the prior version running (design D4).
   */
  private buildPlan(target: string, topo: UpdateTopology): UpdatePlan {
    const projArgs = topo.project ? ['-p', topo.project] : [];
    const fileArgs = topo.composeFiles.flatMap((f) => ['-f', f]);
    const services = [...topo.services];
    const assetStaging = this.buildSandboxAssetStaging(target, topo);
    const pullServices = assetStaging
      ? topo.pullServices.filter((service) => service !== AIO_PULL_ONLY_SERVICE)
      : [...topo.pullServices];
    const base = ['docker', 'compose', ...projArgs, ...fileArgs];
    // PULL the full cap pull set (running cap services PLUS the never-starts
    // pull-only sandbox stager, so its image is staged) but `up -d` ONLY the
    // running cap services (a never-starts service is staged, not recreated).
    const pull = shellJoin([...base, 'pull', ...pullServices]);
    const up = shellJoin([...base, 'up', '-d', ...services]);
    // Ensure compose is present (official docker:*-cli bundles it; this is a no-op
    // fallback that installs it from alpine repos otherwise — the updater has host net).
    // `||`/`&&` are left-associative in POSIX sh, so `A || B && pin && pull && up`
    // parses as `((A || B) && pin && pull && up)` — i.e. ensure compose (present OR
    // installed) THEN proceed; a failed install aborts before pull. No parens needed,
    // and the script stays a leading `docker compose …` op.
    const ensure =
      'docker compose version >/dev/null 2>&1 || apk add --no-cache docker-cli-compose';
    // Persist CAP_VERSION=<target> into the working-dir .env atomically (temp + mv),
    // preserving the other lines, so a later manual `up` does not revert the version.
    // `target` is a validated semver tag (no shell metacharacters), so it is safe to
    // embed in the single-quoted echo.
    const pin =
      `( grep -v '^${CAP_VERSION_ENV}=' .env 2>/dev/null || true; ` +
      `echo '${CAP_VERSION_ENV}=${target}' ) > .env.captmp && mv .env.captmp .env`;
    const script = [ensure, assetStaging, pin, pull, up]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' && ');
    return {
      target,
      project: topo.project,
      composeFiles: [...topo.composeFiles],
      workingDir: topo.workingDir,
      services,
      pullServices,
      commands: [pull, up],
      script,
    };
  }

  /**
   * Build the optional Release-asset staging step for deployments that explicitly
   * opted into `CAP_SANDBOX_IMAGE_DELIVERY=release-assets`. Registry/legacy
   * deployments intentionally return null so their pull-before-recreate behavior
   * stays unchanged.
   */
  private buildSandboxAssetStaging(target: string, topo: UpdateTopology): string | null {
    const delivery = normalizeSandboxImageDelivery(this.env[SANDBOX_IMAGE_DELIVERY_ENV]);
    if (delivery !== 'release-assets') {
      return null;
    }
    const provider = normalizeSandboxProvider(this.env[SANDBOX_PROVIDER_ENV]);
    if (provider === 'control-plane') {
      return buildEnvPersistScript({
        [SANDBOX_IMAGE_DELIVERY_ENV]: 'release-assets',
      });
    }
    const assetDir =
      nonEmptyEnv(this.env[SANDBOX_ASSET_DIR_ENV]) ??
      `${topo.workingDir.replace(/\/+$/, '')}/sandbox-assets`;
    const releasesRepo =
      nonEmptyEnv(this.env[RELEASES_REPO_ENV]) ?? 'Xeonice/cloud-agent-platform';
    const releaseAssetBase =
      nonEmptyEnv(this.env[RELEASE_ASSET_BASE_ENV]) ??
      `https://github.com/${releasesRepo}/releases/download/${target}`;
    return provider === 'boxlite'
      ? buildBoxLiteAssetStagingScript({ target, assetDir, releaseAssetBase })
      : buildAioAssetStagingScript({ target, assetDir, releaseAssetBase });
  }
}

interface SandboxAssetScriptOptions {
  readonly target: string;
  readonly assetDir: string;
  readonly releaseAssetBase: string;
}

function buildAioAssetStagingScript(options: SandboxAssetScriptOptions): string {
  const asset = `cap-aio-sandbox-${options.target}-linux-amd64.docker.tar.zst`;
  const image = `ghcr.io/xeonice/cap-aio-sandbox:${options.target}`;
  const body = `
target=${shQuote(options.target)}
asset_dir=${shQuote(options.assetDir)}
asset_base=${shQuote(options.releaseAssetBase)}
asset=${shQuote(asset)}
image=${shQuote(image)}
cap_prepare_asset_tools
asset_source="$(cap_fetch_and_verify_asset "$target" "$asset_dir" "$asset_base" "$asset")" || exit 1
cap_stream_asset "$asset_source" | zstd -dc | docker load >/dev/null
docker image inspect "$image" >/dev/null
cap_set_env_value ${SANDBOX_IMAGE_DELIVERY_ENV} release-assets
`.trim();
  return `sh -eu -c ${shQuote(`${commonSandboxAssetShell()}\n${body}`)}`;
}

function buildBoxLiteAssetStagingScript(options: SandboxAssetScriptOptions): string {
  const body = `
target=${shQuote(options.target)}
asset_dir=${shQuote(options.assetDir)}
asset_base=${shQuote(options.releaseAssetBase)}
cap_prepare_asset_tools
case "$(uname -m 2>/dev/null || echo unknown)" in
  arm64|aarch64) slug=linux-arm64 ;;
  *) slug=linux-amd64 ;;
esac
asset="cap-boxlite-sandbox-$target-$slug.oci.tar.zst"
asset_source="$(cap_fetch_and_verify_asset "$target" "$asset_dir" "$asset_base" "$asset")" || exit 1
rootfs_dir="$asset_dir/boxlite/cap-boxlite-sandbox/$target/$slug/oci"
# Sweep stale temp dirs from previously failed attempts (pid-named, so the
# per-pid reset below never catches them). The glob is anchored to this
# version's rootfs path; sibling versions and the live oci dir are untouched.
rm -rf "$rootfs_dir".captmp.*
tmp_dir="$rootfs_dir.captmp.$$"
rm -rf "$tmp_dir"
mkdir -p "$tmp_dir" "$(dirname "$rootfs_dir")"
# tar -o (= GNU --no-same-owner): never restore the archive's uid/gid. The
# rootfs has no consumer of archive ownership, and chown is forbidden on
# shared bind mounts (macOS/colima, virtiofs), where restoring it aborts the
# whole staging pipeline. -o is the spelling both busybox and GNU tar accept.
cap_stream_asset "$asset_source" | zstd -dc | tar -C "$tmp_dir" -o -xf -
rm -rf "$rootfs_dir"
mv "$tmp_dir" "$rootfs_dir"
cap_set_env_value ${SANDBOX_IMAGE_DELIVERY_ENV} release-assets
cap_unset_env_value ${BOXLITE_IMAGE_ENV}
cap_unset_env_value ${BOXLITE_IMAGE_MAP_ENV}
cap_unset_env_value ${BOXLITE_ROOTFS_PATH_MAP_ENV}
cap_set_env_value ${BOXLITE_ROOTFS_PATH_ENV} "$rootfs_dir"
cap_set_env_value ${BOXLITE_PROTOCOL_MODE_ENV} native
`.trim();
  return `sh -eu -c ${shQuote(`${commonSandboxAssetShell()}\n${body}`)}`;
}

function buildEnvPersistScript(values: Readonly<Record<string, string>>): string {
  const body = Object.entries(values)
    .map(([key, value]) => `cap_set_env_value ${key} ${shQuote(value)}`)
    .join('\n');
  return `sh -eu -c ${shQuote(`${envFileShell()}\n${body}`)}`;
}

function commonSandboxAssetShell(): string {
  return `
set -o pipefail
${envFileShell()}
cap_prepare_asset_tools() {
  if ! command -v curl >/dev/null 2>&1 || ! command -v zstd >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    apk add --no-cache curl zstd tar
  fi
  command -v sha256sum >/dev/null 2>&1 || apk add --no-cache coreutils
}
cap_download_asset() {
  name="$1"
  out="$2"
  tmp="$out.captmp"
  mkdir -p "$(dirname "$out")"
  rm -f "$tmp"
  curl -fL --retry 3 -o "$tmp" "$asset_base/$name" || {
    rm -f "$tmp"
    return 1
  }
  mv "$tmp" "$out" || return 1
}
cap_manifest_has_asset() {
  manifest="$1"
  name="$2"
  grep -F '"asset"' "$manifest" | grep -Fq "\\"$name\\""
}
cap_verify_file() {
  path="$1"
  checksum="$2"
  expected="$(awk '{ print $1; exit }' "$checksum")"
  actual="$(sha256sum "$path" | awk '{ print $1; exit }')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ]
}
cap_stream_asset() {
  source="$1"
  case "$source" in
    *.parts)
      while IFS= read -r part; do
        [ -f "$part" ]
        cat "$part"
      done < "$source"
      ;;
    *) cat "$source" ;;
  esac
}
cap_fetch_and_verify_asset() {
  target="$1"
  asset_dir="$2"
  asset_base="\${3%/}"
  asset="$4"
  download_dir="$asset_dir/downloads/$target"
  manifest="$download_dir/cap-image-assets.json"
  asset_path="$download_dir/$asset"
  checksum_path="$asset_path.sha256"
  cap_download_asset cap-image-assets.json "$manifest" || return 1
  grep -q "\\"version\\"[[:space:]]*:[[:space:]]*\\"$target\\"" "$manifest" || return 1
  cap_manifest_has_asset "$manifest" "$asset" || return 1
  first_part="$asset.part-0001"
  if cap_manifest_has_asset "$manifest" "$first_part"; then
    descriptor="$asset_path.parts"
    descriptor_tmp="$descriptor.captmp"
    rm -f "$descriptor" "$descriptor_tmp"
    : > "$descriptor_tmp"
    index=1
    while :; do
      part="$asset.part-$(printf '%04d' "$index")"
      cap_manifest_has_asset "$manifest" "$part" || break
      part_path="$download_dir/$part"
      part_checksum="$part_path.sha256"
      cap_download_asset "$part" "$part_path" || return 1
      cap_download_asset "$part.sha256" "$part_checksum" || return 1
      cap_verify_file "$part_path" "$part_checksum" || return 1
      printf '%s\n' "$part_path" >> "$descriptor_tmp" || return 1
      index=$((index + 1))
    done
    [ "$index" -gt 1 ] || return 1
    cap_download_asset "$asset.sha256" "$checksum_path" || return 1
    mv "$descriptor_tmp" "$descriptor" || return 1
    expected="$(awk '{ print $1; exit }' "$checksum_path")"
    actual="$(cap_stream_asset "$descriptor" | sha256sum | awk '{ print $1; exit }')" || return 1
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || return 1
    printf '%s\n' "$descriptor"
    return
  fi
  cap_download_asset "$asset" "$asset_path" || return 1
  cap_download_asset "$asset.sha256" "$checksum_path" || return 1
  cap_verify_file "$asset_path" "$checksum_path" || return 1
  printf '%s\n' "$asset_path"
}
`.trim();
}

function envFileShell(): string {
  return `
cap_set_env_value() {
  key="$1"
  value="$2"
  tmp=".env.captmp.$key.$$"
  ( grep -v "^$key=" .env 2>/dev/null || true; printf '%s=%s\\n' "$key" "$value" ) > "$tmp"
  mv "$tmp" .env
}
cap_unset_env_value() {
  key="$1"
  tmp=".env.captmp.$key.$$"
  ( grep -v "^$key=" .env 2>/dev/null || true ) > "$tmp"
  mv "$tmp" .env
}
`.trim();
}

function normalizeSandboxImageDelivery(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'registry' ||
    normalized === 'release-assets' ||
    normalized === 'auto'
  ) {
    return normalized;
  }
  return 'registry';
}

function normalizeSandboxProvider(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'aio' ||
    normalized === 'boxlite' ||
    normalized === 'control-plane'
  ) {
    return normalized;
  }
  return 'aio';
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellJoin(argv: readonly string[]): string {
  return argv
    .map((value) => (/^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : shQuote(value)))
    .join(' ');
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
 * Live {@link TopologyResolver}: reads the api's OWN container compose labels over
 * the existing docker.sock (same `new Docker()` idiom as the updater and
 * sandbox provider registry wiring) to reconstruct the compose invocation that
 * created the running stack, and derives the cap services as the project's services on `ghcr cap-*`
 * images. Returns `null` when the api was not run via compose (labels absent).
 */
export class DockerTopologyResolver implements TopologyResolver {
  private readonly log = new Logger(DockerTopologyResolver.name);
  private readonly docker = new Docker();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(): Promise<UpdateTopology | null> {
    // The container's hostname defaults to its (short) id; the prod compose sets no
    // custom hostname for the api, so this resolves the api's own container.
    const self = await this.docker
      .getContainer(os.hostname())
      .inspect()
      .catch(() => null);
    const labels = self?.Config?.Labels ?? {};
    const project = labels['com.docker.compose.project'];
    const configFiles = labels['com.docker.compose.project.config_files'];
    const workingDir = labels['com.docker.compose.project.working_dir'];
    if (!project || !configFiles || !workingDir) {
      this.log.warn(
        'self-update: api container has no com.docker.compose.* labels — ' +
          'falling back to operator env / documented compose defaults',
      );
      return null;
    }
    const composeFiles = configFiles
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // RUNNING cap services = the project's CONTAINERS whose image is in the ghcr
    // cap-* namespace. These are the recreate set. A never-starts pull-only cap
    // service (e.g. `aio-sandbox-image`) has NO container and so is absent here by
    // definition — `resolveServiceSets` adds it back to the PULL set (only).
    const containers = await this.docker
      .listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${project}`] },
      })
      .catch(() => []);
    const runningCapServices = [
      ...new Set(
        containers
          .filter((c) => CAP_IMAGE_RE.test(c.Image ?? ''))
          .map((c) => c.Labels?.['com.docker.compose.service'])
          .filter((s): s is string => typeof s === 'string' && s.length > 0),
      ),
    ];
    const { services, pullServices } = resolveServiceSets(runningCapServices, this.env);

    return { project, composeFiles, workingDir, services, pullServices };
  }
}

/**
 * Live {@link UpdaterLauncher}: creates + starts a DETACHED one-shot helper
 * container (same `new Docker()` docker.sock idiom as the sandbox provider registry)
 * that runs the bounded compose script. The container mounts the host docker socket
 * and the deployment's working dir (+ any compose-file dir outside it), runs on the
 * host network (so it can reach the docker daemon + registries while the api goes
 * down), and `AutoRemove`s itself when done. Because it is its OWN container, it
 * OUTLIVES the api's recreate.
 */
export class DockerUpdaterLauncher implements UpdaterLauncher {
  private readonly docker = new Docker();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async launch(plan: UpdatePlan): Promise<void> {
    const image = nonEmptyEnv(this.env[UPDATER_IMAGE_ENV]) ?? DEFAULT_UPDATER_IMAGE;
    // createContainer does NOT auto-pull — a host that never staged the updater image
    // (e.g. a fresh resident deploy with no `docker` images) otherwise fails the whole
    // request with `(HTTP code 404) … No such image`. Ensure it is present first.
    await this.ensureImage(image);
    // The single pin every cap service resolves `${CAP_VERSION}` to (overrides the
    // .env at compose render time; the script also persists it into .env).
    const containerEnv = [`${CAP_VERSION_ENV}=${plan.target}`];

    const binds = [
      '/var/run/docker.sock:/var/run/docker.sock',
      ...updaterBindDirs(plan.workingDir, plan.composeFiles).map((d) => `${d}:${d}`),
    ];

    const container = await this.docker.createContainer({
      Image: image,
      // The bounded script: ensure compose, persist the pin, pull THEN up -d, cap
      // services only. `-c` takes a single string built ENTIRELY from server-side
      // values (Docker labels + the validated target), so there is no injection surface.
      Cmd: ['sh', '-c', plan.script],
      Env: containerEnv,
      WorkingDir: plan.workingDir,
      HostConfig: {
        AutoRemove: true,
        NetworkMode: 'host',
        Binds: binds,
      },
    });
    // DETACHED: start and return; the helper outlives THIS api process when `up -d`
    // recreates the api container.
    await container.start();
  }

  /**
   * Guarantee the updater image is present locally before {@link launch} creates a
   * container from it (dockerode's createContainer never auto-pulls). Inspect first
   * and pull ONLY on a miss, so the steady-state path stays offline-friendly and a
   * fresh host self-heals instead of 404-ing the request.
   */
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return; // already staged — nothing to pull
    } catch {
      // not present locally — fall through to pull
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}

/** The parent directory of an absolute path (`/a/b/c` → `/a/b`; `/a` → `/`). */
function parentDir(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i > 0 ? trimmed.slice(0, i) : '/';
}

/**
 * The host directories the detached updater must bind-mount so `docker compose`
 * resolves everything it reads. CRITICAL: it includes the working dir's PARENT,
 * because a compose `env_file:` (or other relative path) can point OUTSIDE the
 * working dir — the resident layout uses `env_file: ../files/api.env`, i.e.
 * `<project>/files/api.env`, a SIBLING of `<project>/resident/`. Binding only the
 * working dir made compose silently skip that `required:false` env_file inside the
 * updater container, dropping the api's secrets (SESSION_SECRET/CODEX_CRED_ENC_KEY/…)
 * on recreate. Binding the parent covers `../<sibling>/…`. Also binds each compose
 * file's own dir. (Deeply-relative env_files like `../../x` would need the working
 * dir set higher / an explicit bind; the parent covers the standard project layout.)
 */
export function updaterBindDirs(
  workingDir: string,
  composeFiles: readonly string[],
): string[] {
  const dirs = new Set<string>();
  const add = (p: string): void => {
    if (p && p.startsWith('/')) dirs.add(p.replace(/\/+$/, '') || '/');
  };
  add(workingDir);
  add(parentDir(workingDir)); // so `env_file: ../files/api.env` (a sibling dir) resolves
  for (const f of composeFiles) add(parentDir(f));
  return [...dirs];
}

/** A trimmed non-empty string, or `null` for undefined/blank. */
function nonEmptyEnv(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length === 0 ? null : t;
}

/** Parse a comma-separated env list into a trimmed non-empty array, or `null` if unset/blank. */
function parseList(value: string | undefined): string[] | null {
  if (typeof value !== 'string') return null;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : null;
}

/**
 * Split a project's declared cap services into the RECREATE set (running cap units
 * to `up -d`) and the PULL set (every cap image to stage at the target). The pull
 * set is `(declared minus pull-only) ∪ pull-only` — it ALWAYS includes the declared
 * never-starts pull-only cap services (so the sandbox image is staged), while the
 * recreate set EXCLUDES them (they never run). Pull-only services come from
 * `SELF_UPDATE_PULL_ONLY_SERVICES` (else {@link PULL_ONLY_CAP_SERVICES}; an
 * explicitly-empty env disables the addition). Deduped, order-stable (recreate
 * first). Every member is a cap service, so BOTH sets stay cap-namespace-scoped.
 */
export function resolveServiceSets(
  declaredCapServices: readonly string[],
  env: NodeJS.ProcessEnv,
): { services: string[]; pullServices: string[] } {
  const raw = env[PULL_ONLY_SERVICES_ENV];
  const pullOnly =
    typeof raw === 'string' ? (parseList(raw) ?? []) : [...PULL_ONLY_CAP_SERVICES];
  const pullOnlySet = new Set(pullOnly);
  const services = declaredCapServices.filter((s) => !pullOnlySet.has(s));
  const pullServices = [...new Set([...services, ...pullOnly])];
  return { services, pullServices };
}
