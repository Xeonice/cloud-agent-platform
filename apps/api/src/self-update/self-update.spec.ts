/**
 * `POST /self-update` self-update spec (self-update-action + self-update-resident-topology).
 *
 * The endpoint is the most dangerous surface in the OSS self-update epic — a
 * host-root container op behind a button — so the tests are dominated by proving
 * the CONTAINMENT, NOT by recreating anything: assert the constructed command/plan
 * and the gate/validation order, never actually recreate.
 *
 * Topology is now DERIVED from the running deployment (self-update-resident-topology):
 * the unit cases inject a FAKE {@link TopologyResolver} so the plan is built from a
 * deterministic topology WITHOUT docker, and assert the plan/script reflect that
 * derived topology (project / -f files / working dir / cap-* services), the
 * `CAP_VERSION` `.env` writeback, the labels-absent FALLBACK, and the unchanged
 * gates/cross-check/pull-then-up ordering.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  type INestApplication,
} from '@nestjs/common';
import type { UpdateStatus } from '@cap/contracts';

import { SelfUpdateController } from './self-update.controller';
import {
  SelfUpdateService,
  SelfUpdateRefusedError,
  SELF_UPDATE_ENABLED_ENV,
  CAP_SERVICES,
  COMPOSE_FILES,
  DEFAULT_COMPOSE_PROJECT_DIR,
  isSemverTag,
  updaterBindDirs,
  resolveServiceSets,
  PULL_ONLY_SERVICES_ENV,
  SANDBOX_IMAGE_DELIVERY_ENV,
  SANDBOX_PROVIDER_ENV,
  SANDBOX_ENVIRONMENT_TARGET_CONTRACT_ENV,
  type UpdatePlan,
  type UpdaterLauncher,
  type UpdateTopology,
  type TopologyResolver,
} from './self-update.service';
import { SANDBOX_ENVIRONMENT_CONTRACT_VERSION } from '../sandbox-environments/sandbox-environments.service';
import { UpdateStatusService } from '../update-status/update-status.service';
import type { OperatorPrincipal } from '../auth/operator-principal';

const LATEST = 'v1.4.0';

/**
 * The derived topology a real resident deployment would expose (no `web`):
 * `services` is the RECREATE set (running cap services — just `api`), `pullServices`
 * is the PULL set (api + the never-starts pull-only `aio-sandbox-image` stager).
 */
const FAKE_TOPO: UpdateTopology = {
  project: 'cloud-agent-platform',
  composeFiles: ['/etc/cap/resident/docker-compose.prod.yml'],
  workingDir: '/etc/cap/resident',
  services: ['api'],
  pullServices: ['api', 'aio-sandbox-image'],
};

/** A resolver that returns a fixed topology (or null to exercise the fallback). */
function fakeResolver(topo: UpdateTopology | null): TopologyResolver {
  return { resolve: async () => topo };
}

/** A fake UpdateStatusService that reports a fixed latest (or "up to date"). */
function fakeUpdateStatus(opts: {
  latestVersion: string | null;
  updateAvailable: boolean;
}): UpdateStatusService {
  const status: UpdateStatus = {
    currentVersion: 'v1.3.0',
    latestVersion: opts.latestVersion,
    updateAvailable: opts.updateAvailable,
    releaseUrl: null,
    releaseName: null,
    checkedAt: new Date(0).toISOString(),
  };
  return {
    getStatus: async () => status,
  } as unknown as UpdateStatusService;
}

/** A launcher that records the plan it was handed and never touches docker. */
function capturingLauncher(): { launcher: UpdaterLauncher; launched: () => UpdatePlan[] } {
  const plans: UpdatePlan[] = [];
  return {
    launcher: {
      async launch(plan: UpdatePlan) {
        plans.push(plan);
      },
    },
    launched: () => plans,
  };
}

function makeService(opts: {
  enabled: boolean;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  launcher: UpdaterLauncher;
  topology?: UpdateTopology | null; // undefined → FAKE_TOPO; null → fallback path
  env?: NodeJS.ProcessEnv;
  sandboxEnvironments?: { markCustomEnvironmentsStale(contractVersion: string): Promise<number> };
}): SelfUpdateService {
  const env: NodeJS.ProcessEnv = {
    ...(opts.enabled ? { [SELF_UPDATE_ENABLED_ENV]: 'true' } : {}),
    ...(opts.env ?? {}),
  };
  const topo = opts.topology === undefined ? FAKE_TOPO : opts.topology;
  return new SelfUpdateService(
    fakeUpdateStatus({
      latestVersion: opts.latestVersion ?? LATEST,
      updateAvailable: opts.updateAvailable ?? true,
    }),
    opts.launcher,
    env,
    fakeResolver(topo),
    opts.sandboxEnvironments,
  );
}

// ---------------------------------------------------------------------------
// Service unit scenarios — the containment proof
// ---------------------------------------------------------------------------

test('disabled by default: SELF_UPDATE_ENABLED unset → refuses, no launch', async () => {
  const { launcher, launched } = capturingLauncher();
  const svc = makeService({ enabled: false, launcher });

  await assert.rejects(
    () => svc.requestUpdate(LATEST),
    (err: unknown) =>
      err instanceof SelfUpdateRefusedError && err.reason === 'disabled',
    'a disabled instance refuses with reason "disabled"',
  );
  assert.equal(launched().length, 0, 'no detached updater is launched when disabled');
});

test('target mismatch: target != /update-status latest → rejected, no launch', async () => {
  const { launcher, launched } = capturingLauncher();
  const svc = makeService({ enabled: true, latestVersion: LATEST, launcher });

  await assert.rejects(
    () => svc.requestUpdate('v9.9.9'),
    (err: unknown) =>
      err instanceof SelfUpdateRefusedError && err.reason === 'target-mismatch',
    'a target that is not the reported latest is rejected (no arbitrary version forced)',
  );
  assert.equal(launched().length, 0, 'no launch on a mismatched target');
});

test('no update available: even the latest tag is rejected when updateAvailable is false', async () => {
  const { launcher, launched } = capturingLauncher();
  const svc = makeService({
    enabled: true,
    latestVersion: LATEST,
    updateAvailable: false,
    launcher,
  });

  await assert.rejects(
    () => svc.requestUpdate(LATEST),
    (err: unknown) =>
      err instanceof SelfUpdateRefusedError && err.reason === 'target-mismatch',
    'no update available → nothing to apply',
  );
  assert.equal(launched().length, 0, 'no launch when no update is available');
});

test('invalid target: a non-semver tag is rejected before any cross-check or launch', async () => {
  const { launcher, launched } = capturingLauncher();
  const svc = makeService({ enabled: true, launcher });

  for (const bad of ['latest', 'main', '../etc', 'v1.2', 'v1.2.3; rm -rf /', '']) {
    await assert.rejects(
      () => svc.requestUpdate(bad),
      (err: unknown) =>
        err instanceof SelfUpdateRefusedError && err.reason === 'invalid-target',
      `"${bad}" is not a valid semver target`,
    );
  }
  assert.equal(launched().length, 0, 'no launch on an invalid target');
});

test('isSemverTag accepts release tags and rejects moving tags / injection', () => {
  for (const ok of ['v1.2.3', '1.2.3', 'v1.4.0', 'v2.0.0-rc.1', '1.0.0+build.5']) {
    assert.equal(isSemverTag(ok), true, `${ok} is a valid semver tag`);
  }
  for (const bad of ['latest', 'v1', 'v1.2', '1.2.3.4', 'main', 'v1.2.3 && reboot', '']) {
    assert.equal(isSemverTag(bad), false, `${bad} is rejected`);
  }
});

test('enabled + valid: BOUNDED plan is DERIVED from the running topology (cap-* services, target pinned)', async () => {
  const { launcher, launched } = capturingLauncher();
  const svc = makeService({ enabled: true, latestVersion: LATEST, launcher });

  const plan = await svc.requestUpdate(LATEST);

  // The launcher was handed exactly the returned plan — the ack mirrors what is launched.
  assert.equal(launched().length, 1, 'the detached updater was launched once');
  assert.deepEqual(launched()[0], plan, 'the launched plan is the acked plan');

  // BOUNDED: the validated target is the pin.
  assert.equal(plan.target, LATEST, 'the plan pins the validated target');

  // DERIVED topology: project / -f files / working dir / services come from the
  // running deployment (the injected resolver), not fixed source-overlay literals.
  assert.equal(plan.project, FAKE_TOPO.project, 'project from the running deployment');
  assert.deepEqual(plan.composeFiles, FAKE_TOPO.composeFiles, 'compose -f files derived');
  assert.equal(plan.workingDir, FAKE_TOPO.workingDir, 'working dir derived');
  assert.deepEqual(plan.services, FAKE_TOPO.services, 'recreate set = running cap services (no web, no never-starts stager)');
  assert.deepEqual(plan.pullServices, FAKE_TOPO.pullServices, 'pull set = running cap + the pull-only sandbox stager');

  // The command layers the derived project + files and scopes to the derived services.
  assert.ok(plan.script.includes(`-p ${FAKE_TOPO.project}`), 'the command scopes to the derived project');
  for (const f of FAKE_TOPO.composeFiles) {
    assert.ok(plan.script.includes(`-f ${f}`), `the command layers ${f}`);
  }
  const [pullCmd, upCmd] = plan.commands;
  assert.ok(pullCmd.endsWith('pull api aio-sandbox-image'), 'pull stages the full cap pull set (incl the sandbox image)');
  assert.ok(upCmd.endsWith('up -d api'), 'up -d recreates ONLY the running cap services');
  assert.ok(!upCmd.includes('aio-sandbox-image'), 'up -d does NOT recreate the never-starts pull-only sandbox stager');

  // BOUNDED: never a non-cap unit, never an inline image ref.
  for (const forbidden of ['postgres', 'loki', 'grafana', 'nginx', 'ghcr.io']) {
    assert.ok(!plan.services.includes(forbidden), `the plan must never touch ${forbidden}`);
    assert.ok(!plan.script.includes(forbidden), `the command must never contain ${forbidden}`);
  }
  // No destructive command — word-boundary `\brm\b` so it never false-positives on
  // "platfoRM -f"; the script is only docker compose + the known ensure/pin ops.
  assert.ok(!/\brm\b/.test(plan.script), 'the command must never run rm');
  // The target rides CAP_VERSION (env + .env pin), not an inline registry image/tag.
  assert.ok(plan.script.startsWith('docker compose '), 'the script begins with a docker compose op (the ensure guard)');
});

test('the upgrade persists the CAP_VERSION pin into the deployment .env', async () => {
  const { launcher } = capturingLauncher();
  const svc = makeService({ enabled: true, latestVersion: LATEST, launcher });

  const plan = await svc.requestUpdate(LATEST);

  // The script rewrites .env's CAP_VERSION to the target (atomic temp + mv) so a later
  // manual `up` does not revert the version.
  assert.ok(plan.script.includes(`CAP_VERSION=${LATEST}`), 'the script pins CAP_VERSION=<target> into .env');
  assert.ok(plan.script.includes('.env.captmp') && plan.script.includes('mv .env.captmp .env'),
    'the .env pin is written atomically via a temp file + rename');
  // And it ensures the compose plugin is present first (no-op when already bundled).
  assert.ok(plan.script.includes('docker compose version') && plan.script.includes('apk add'),
    'the script idempotently ensures the compose plugin before acting');
});

test('accepted self-update marks custom sandbox environments stale by contract version without replacing sources', async () => {
  const { launcher, launched } = capturingLauncher();
  const staleContracts: string[] = [];
  const svc = makeService({
    enabled: true,
    latestVersion: LATEST,
    launcher,
    sandboxEnvironments: {
      async markCustomEnvironmentsStale(contractVersion: string) {
        staleContracts.push(contractVersion);
        return 2;
      },
    },
  });

  await svc.requestUpdate(LATEST);

  assert.deepEqual(
    staleContracts,
    [SANDBOX_ENVIRONMENT_CONTRACT_VERSION],
    'self-update uses the sandbox environment contract metadata for stale gating',
  );
  assert.equal(launched().length, 1, 'the accepted update still launches');
});

test('target sandbox contract metadata can mark custom environments stale before a newer release starts', async () => {
  const { launcher } = capturingLauncher();
  const staleContracts: string[] = [];
  const svc = makeService({
    enabled: true,
    latestVersion: LATEST,
    launcher,
    env: { [SANDBOX_ENVIRONMENT_TARGET_CONTRACT_ENV]: 'sandbox-environment-v3' },
    sandboxEnvironments: {
      async markCustomEnvironmentsStale(contractVersion: string) {
        staleContracts.push(contractVersion);
        return 1;
      },
    },
  });

  await svc.requestUpdate(LATEST);

  assert.deepEqual(staleContracts, ['sandbox-environment-v3']);
});

test('pull-then-recreate ordering: pull is FIRST, up -d SECOND, joined by &&', async () => {
  const { launcher } = capturingLauncher();
  const svc = makeService({ enabled: true, latestVersion: LATEST, launcher });

  const plan = await svc.requestUpdate(LATEST);

  assert.equal(plan.commands.length, 2, 'exactly two ordered compose commands');
  const [pull, up] = plan.commands;
  assert.ok(pull.includes(' pull '), 'first command pulls the new images');
  assert.ok(up.includes(' up -d '), 'second command recreates the services');
  assert.ok(
    plan.script.indexOf(' pull ') < plan.script.indexOf(' up -d '),
    'pull precedes up -d (a failed pull leaves the prior version running)',
  );
  assert.ok(plan.script.includes(' && '), 'commands joined by && so up -d only runs on success');
});

test('release-assets AIO self-update stages the Docker archive before pin/pull/recreate', async () => {
  const { launcher } = capturingLauncher();
  const svc = makeService({
    enabled: true,
    latestVersion: LATEST,
    launcher,
    env: {
      [SANDBOX_IMAGE_DELIVERY_ENV]: 'release-assets',
      [SANDBOX_PROVIDER_ENV]: 'aio',
    },
  });

  const plan = await svc.requestUpdate(LATEST);

  assert.deepEqual(plan.pullServices, ['api'], 'release-assets removes the AIO pull-only stager from the pull set');
  assert.ok(plan.commands[0].endsWith('pull api'), 'compose pull still stages the running cap service image');
  assert.ok(!plan.commands[0].includes('aio-sandbox-image'), 'compose pull no longer pulls the AIO stager service');
  assert.ok(plan.script.includes('cap-image-assets.json'), 'the updater fetches the Release asset manifest');
  assert.ok(
    plan.script.includes(`cap-aio-sandbox-${LATEST}-linux-amd64.docker.tar.zst`),
    'the updater downloads the target AIO Docker archive asset',
  );
  assert.ok(plan.script.includes('zstd -dc "$asset_path" | docker load'), 'the updater loads the Docker archive');
  assert.ok(
    plan.script.includes(`ghcr.io/xeonice/cap-aio-sandbox:${LATEST}`),
    'the post-load inspect checks the target sandbox image',
  );
  assert.ok(
    plan.script.indexOf('cap-image-assets.json') < plan.script.indexOf(`CAP_VERSION=${LATEST}`),
    'asset staging runs before the CAP_VERSION pin is persisted',
  );
  assert.ok(
    plan.script.indexOf(`CAP_VERSION=${LATEST}`) < plan.script.indexOf(' pull '),
    'the target pin still happens before compose pull',
  );
});

test('release-assets BoxLite self-update extracts rootfs and persists BOXLITE_ROOTFS_PATH before recreate', async () => {
  const { launcher } = capturingLauncher();
  const svc = makeService({
    enabled: true,
    latestVersion: LATEST,
    launcher,
    env: {
      [SANDBOX_IMAGE_DELIVERY_ENV]: 'release-assets',
      [SANDBOX_PROVIDER_ENV]: 'boxlite',
    },
  });

  const plan = await svc.requestUpdate(LATEST);

  assert.deepEqual(plan.pullServices, ['api'], 'BoxLite asset mode does not pull the AIO stager service');
  assert.ok(plan.script.includes('cap-boxlite-sandbox-$target-$slug.oci.tar.zst'), 'the updater selects a platform BoxLite OCI asset');
  assert.ok(plan.script.includes('zstd -dc "$asset_path" | tar -C "$tmp_dir" -xf -'), 'the updater extracts the OCI archive locally');
  assert.ok(plan.script.includes('cap_unset_env_value BOXLITE_IMAGE'), 'BoxLite rootfs mode removes image env');
  assert.ok(plan.script.includes('cap_unset_env_value BOXLITE_IMAGE_MAP'), 'BoxLite rootfs mode removes image map env');
  assert.ok(plan.script.includes('cap_set_env_value BOXLITE_ROOTFS_PATH "$rootfs_dir"'), 'BoxLite rootfs mode writes the staged rootfs path');
  assert.ok(plan.script.includes('cap_set_env_value BOXLITE_PROTOCOL_MODE native'), 'BoxLite rootfs mode persists native protocol');
  assert.ok(
    plan.script.indexOf('BOXLITE_ROOTFS_PATH') < plan.script.indexOf(`CAP_VERSION=${LATEST}`),
    'rootfs env is persisted only after extraction and before the target pin',
  );
});

test('registry-backed self-update preserves the existing pull-only stager behavior', async () => {
  const { launcher } = capturingLauncher();
  const svc = makeService({
    enabled: true,
    latestVersion: LATEST,
    launcher,
    env: {
      [SANDBOX_IMAGE_DELIVERY_ENV]: 'registry',
      [SANDBOX_PROVIDER_ENV]: 'aio',
    },
  });

  const plan = await svc.requestUpdate(LATEST);

  assert.deepEqual(plan.pullServices, FAKE_TOPO.pullServices, 'registry mode keeps the existing pull set');
  assert.ok(plan.commands[0].endsWith('pull api aio-sandbox-image'), 'registry mode still pulls the stager service');
  assert.ok(!plan.script.includes('cap-image-assets.json'), 'registry mode does not fetch Release assets');
});

test('labels-absent FALLBACK: resolver returns null → documented literals (source overlay)', async () => {
  const { launcher } = capturingLauncher();
  const svc = makeService({ enabled: true, latestVersion: LATEST, launcher, topology: null });

  const plan = await svc.requestUpdate(LATEST);

  // No compose labels → fall back to the documented literals (no project, source overlay).
  assert.equal(plan.project, '', 'no -p in the fallback (compose default project)');
  assert.deepEqual(plan.composeFiles, [...COMPOSE_FILES], 'fallback layers the source-overlay files');
  assert.deepEqual(plan.services, ['api', 'web'], 'fallback recreate set = documented cap services minus the pull-only stager');
  assert.ok(plan.pullServices.includes('aio-sandbox-image'), 'fallback pull set still stages the never-starts sandbox image');
  assert.equal(plan.workingDir, DEFAULT_COMPOSE_PROJECT_DIR, 'fallback uses the documented project dir');
  assert.ok(!plan.script.includes('-p '), 'no -p flag when there is no project');
});

test('resolveServiceSets: pull set = recreate ∪ pull-only (deduped); recreate excludes the pull-only stager', () => {
  // Running cap services never include the never-starts stager (it has no container),
  // so the pull set adds it back — only to the PULL set.
  const running = resolveServiceSets(['api'], {});
  assert.deepEqual(running.services, ['api'], 'recreate = running cap services, no pull-only');
  assert.deepEqual(running.pullServices, ['api', 'aio-sandbox-image'], 'pull = running cap + the default pull-only stager');

  // The documented fallback set (which DOES list the stager) splits the same way:
  const split = resolveServiceSets([...CAP_SERVICES], {});
  assert.deepEqual(split.services, ['api', 'web'], 'recreate strips the never-starts pull-only stager');
  assert.deepEqual(split.pullServices, ['api', 'web', 'aio-sandbox-image'], 'pull keeps it, deduped + order-stable');

  // Both sets stay strictly cap-scoped — never a non-cap unit.
  for (const forbidden of ['postgres', 'loki', 'grafana']) {
    assert.ok(
      !split.pullServices.includes(forbidden) && !split.services.includes(forbidden),
      `neither set ever names ${forbidden}`,
    );
  }
});

test('resolveServiceSets: SELF_UPDATE_PULL_ONLY_SERVICES overrides the default; an empty value disables it', () => {
  // Override the pull-only declaration with operator env:
  const overridden = resolveServiceSets(['api'], {
    [PULL_ONLY_SERVICES_ENV]: 'aio-sandbox-image, extra-stager',
  });
  assert.deepEqual(
    overridden.pullServices,
    ['api', 'aio-sandbox-image', 'extra-stager'],
    'the pull set uses the operator override',
  );
  assert.deepEqual(overridden.services, ['api'], 'the recreate set still excludes every pull-only entry');

  // An explicitly-empty value disables the pull-only addition (pull set == recreate set):
  const disabled = resolveServiceSets(['api'], { [PULL_ONLY_SERVICES_ENV]: '' });
  assert.deepEqual(disabled.pullServices, ['api'], 'an explicitly-empty env disables the pull-only addition');
  assert.deepEqual(disabled.services, ['api'], 'recreate set unaffected');
});

test('updater binds the working dir AND its parent so a sibling env_file (../files/api.env) resolves', () => {
  // Regression: binding ONLY the working dir made the detached updater's compose run
  // silently skip `env_file: ../files/api.env` (required:false), dropping the api's
  // secrets (SESSION_SECRET/CODEX_CRED_ENC_KEY/…) on recreate → broken login.
  const workingDir = '/etc/dokploy/compose/cloud-agent-platform/resident';
  const dirs = updaterBindDirs(workingDir, [`${workingDir}/docker-compose.prod.yml`]);
  assert.ok(dirs.includes(workingDir), 'binds the working dir (its .env)');
  const parent = '/etc/dokploy/compose/cloud-agent-platform';
  assert.ok(dirs.includes(parent), 'binds the working-dir PARENT so a sibling env_file dir is visible');
  // The resident env_file `../files/api.env` resolves under the bound parent.
  assert.ok(
    `${parent}/files/api.env`.startsWith(`${parent}/`),
    'sanity: ../files/api.env lives under the bound parent dir',
  );
});

test('no cap service resolvable → refused (no-cap-service), no launch', async () => {
  const { launcher, launched } = capturingLauncher();
  const svc = makeService({
    enabled: true,
    latestVersion: LATEST,
    launcher,
    topology: { project: 'cloud-agent-platform', composeFiles: ['/x/c.yml'], workingDir: '/x', services: [], pullServices: [] },
  });

  await assert.rejects(
    () => svc.requestUpdate(LATEST),
    (err: unknown) =>
      err instanceof SelfUpdateRefusedError && err.reason === 'no-cap-service',
    'a topology with no cap-* service is refused rather than recreating nothing/everything',
  );
  assert.equal(launched().length, 0, 'no launch when no cap service resolves');
});

test('a v-prefix mismatch between client and GitHub tag still matches the exact release', async () => {
  const { launcher, launched } = capturingLauncher();
  // GitHub reports the bare "1.4.0"; the client sends "v1.4.0" — same release.
  const svc = makeService({ enabled: true, latestVersion: '1.4.0', launcher });

  const plan = await svc.requestUpdate('v1.4.0');
  assert.equal(launched().length, 1, 'a v-prefix-only difference is the same release → launches');
  assert.equal(plan.target, '1.4.0', 'the plan pins the server-reported latest');
});

// ---------------------------------------------------------------------------
// HTTP boot — the layered controller refusals (admin gate + env gate) + the ack
// ---------------------------------------------------------------------------

/** A guard that attaches a configurable principal, standing in for the real AuthGuard. */
let currentPrincipal: OperatorPrincipal | null = null;

@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (currentPrincipal === null) {
      return false; // 403/forbidden by Nest's APP_GUARD when false
    }
    const req = context.switchToHttp().getRequest();
    req.operatorPrincipal = currentPrincipal;
    return true;
  }
}

const ADMIN_ID = 4242;
const NON_ADMIN_ID = 7;

function sessionPrincipal(githubId: number, role: 'admin' | 'member' = 'member'): OperatorPrincipal {
  return {
    kind: 'session',
    user: { id: `user-${githubId}`, githubId, login: 'op', name: 'Op', avatarUrl: '', allowed: true, role, mustChangePassword: false },
  };
}

/** The capturing launcher used by the booted service so the HTTP test never touches docker. */
const httpLauncher = capturingLauncher();
/** A mutable env the booted service reads, so a single app exercises enabled + disabled. */
const httpEnv: NodeJS.ProcessEnv = {};

let app: INestApplication;
let port: number;

before(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [SelfUpdateController],
    providers: [
      {
        provide: SelfUpdateService,
        useFactory: () =>
          // Inject a fake topology resolver so the HTTP path never touches docker.
          new SelfUpdateService(
            fakeUpdateStatus({ latestVersion: LATEST, updateAvailable: true }),
            httpLauncher.launcher,
            httpEnv,
            fakeResolver(FAKE_TOPO),
          ),
      },
      { provide: APP_GUARD, useClass: StubAuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.listen(0);
  const address = app.getHttpServer().address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  await app?.close();
});

function postSelfUpdate(target: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/self-update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target }),
  });
}

test('HTTP: a non-admin authenticated operator is 403 (admin gate), service never launches', async () => {
  httpEnv[SELF_UPDATE_ENABLED_ENV] = 'true'; // even enabled, a non-admin is refused
  currentPrincipal = sessionPrincipal(NON_ADMIN_ID);
  const before = httpLauncher.launched().length;

  const res = await postSelfUpdate(LATEST);
  assert.equal(res.status, 403, 'a non-admin operator cannot trigger an upgrade');
  assert.equal(httpLauncher.launched().length, before, 'no detached updater launched for a non-admin');
});

test('HTTP: an admin on a DISABLED instance is refused 404 (env gate), no launch', async () => {
  delete httpEnv[SELF_UPDATE_ENABLED_ENV]; // disabled → inert
  currentPrincipal = sessionPrincipal(ADMIN_ID, 'admin');
  const before = httpLauncher.launched().length;

  const res = await postSelfUpdate(LATEST);
  assert.equal(res.status, 404, 'a disabled instance behaves as if the endpoint is absent');
  assert.equal(httpLauncher.launched().length, before, 'no launch on a disabled instance even for an admin');
});

test('HTTP: an admin + enabled + valid target ACKS update-started and launches the detached updater', async () => {
  httpEnv[SELF_UPDATE_ENABLED_ENV] = 'true';
  currentPrincipal = sessionPrincipal(ADMIN_ID, 'admin');
  const before = httpLauncher.launched().length;

  const res = await postSelfUpdate(LATEST);
  assert.equal(res.status, 202, 'the request is accepted (ack before the api restarts)');
  const body = (await res.json()) as { status: string; target: string };
  assert.equal(body.status, 'update-started', 'acks update-started');
  assert.equal(body.target, LATEST, 'acks the validated target');
  assert.equal(httpLauncher.launched().length, before + 1, 'the detached updater was launched');
});

test('HTTP: an admin + enabled + MISMATCHED target is rejected 422, no launch', async () => {
  httpEnv[SELF_UPDATE_ENABLED_ENV] = 'true';
  currentPrincipal = sessionPrincipal(ADMIN_ID, 'admin');
  const before = httpLauncher.launched().length;

  const res = await postSelfUpdate('v9.9.9');
  assert.equal(res.status, 422, 'a target that is not the reported latest is rejected');
  assert.equal(httpLauncher.launched().length, before, 'no launch on a mismatched target');
});
