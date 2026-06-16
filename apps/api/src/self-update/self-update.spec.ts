/**
 * `POST /self-update` self-update spec (self-update-action, track api-self-update,
 * task 1.3).
 *
 * The endpoint is the most dangerous surface in the OSS self-update epic — a
 * host-root container op behind a button — so the tests are dominated by proving
 * the CONTAINMENT, NOT by recreating anything. Per the task: do NOT actually
 * recreate; assert the constructed command/plan and the gate/validation order.
 *
 * Two complementary layers:
 *
 *  - SERVICE unit cases drive the REAL {@link SelfUpdateService} with a fake
 *    {@link UpdateStatusService} (deterministic latest) + a CAPTURING
 *    {@link UpdaterLauncher} (records the plan, never touches docker), proving:
 *      - disabled-by-default refuses (`SELF_UPDATE_ENABLED` unset → `disabled`,
 *        no launch);
 *      - target-mismatch rejected (target != /update-status latest → no launch);
 *      - invalid (non-semver) target rejected → no launch;
 *      - enabled + valid → the BOUNDED plan: fixed compose-file layering, cap
 *        services ONLY, the single `CAP_VERSION=<target>` pin, no arbitrary
 *        image/tag/command;
 *      - pull-then-recreate ordering (pull BEFORE up -d, joined by `&&`);
 *      - the launcher runs (the ack happens after launch is initiated → "before
 *        restart" — the launch returns control to the handler, which acks, and the
 *        recreate of the api happens inside the detached helper afterwards).
 *
 *  - An HTTP boot case proves the layered refusals through the controller with the
 *    SAME global {@link AuthGuard} shape the app wires:
 *      - a NON-ADMIN authenticated operator is 403'd (admin gate), and the service
 *        is never reached;
 *      - a DISABLED instance refuses 404 even for an admin (env gate);
 *      - an admin + enabled + valid request ACKS `update-started` and the detached
 *        launcher is invoked (asserted via a capturing launcher, no real docker).
 *
 * Run from `apps/api` with `pnpm test`: the pretest compiles `.spec.ts` → `dist`
 * via `nest build`, then `node --test` runs the emitted CommonJS — the same
 * convention as update-status.spec.ts.
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
  isSemverTag,
  type UpdatePlan,
  type UpdaterLauncher,
} from './self-update.service';
import { UpdateStatusService } from '../update-status/update-status.service';
import { SELF_UPDATE_ADMINS_ENV } from '../auth/admin';
import type { OperatorPrincipal } from '../auth/operator-principal';

const LATEST = 'v1.4.0';

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
}): SelfUpdateService {
  const env: NodeJS.ProcessEnv = opts.enabled
    ? { [SELF_UPDATE_ENABLED_ENV]: 'true' }
    : {};
  return new SelfUpdateService(
    fakeUpdateStatus({
      latestVersion: opts.latestVersion ?? LATEST,
      updateAvailable: opts.updateAvailable ?? true,
    }),
    opts.launcher,
    env,
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

test('enabled + admin + valid: constructs the BOUNDED plan (cap services only, target pinned)', async () => {
  const { launcher, launched } = capturingLauncher();
  const svc = makeService({ enabled: true, latestVersion: LATEST, launcher });

  const plan = await svc.requestUpdate(LATEST);

  // The launcher was handed exactly the returned plan — the ack mirrors what is launched.
  assert.equal(launched().length, 1, 'the detached updater was launched once');
  assert.deepEqual(launched()[0], plan, 'the launched plan is the acked plan');

  // BOUNDED: the validated target is the pin.
  assert.equal(plan.target, LATEST, 'the plan pins the validated target');

  // BOUNDED: only the cap compose services, never an arbitrary unit.
  assert.deepEqual(plan.services, [...CAP_SERVICES], 'cap services only');
  for (const forbidden of ['postgres', 'loki', 'grafana', 'nginx']) {
    assert.ok(
      !plan.services.includes(forbidden),
      `the plan must never touch ${forbidden}`,
    );
    assert.ok(
      !plan.script.includes(forbidden),
      `the command must never name ${forbidden}`,
    );
  }

  // BOUNDED: the fixed compose-file layering (base + image override).
  assert.deepEqual(plan.composeFiles, [...COMPOSE_FILES], 'fixed compose-file layering');
  for (const f of COMPOSE_FILES) {
    assert.ok(plan.script.includes(`-f ${f}`), `the command layers ${f}`);
  }

  // BOUNDED: no arbitrary image/tag/command — only `docker compose`, the pin rides
  // CAP_VERSION (env), and the script never embeds a registry image ref/tag.
  assert.ok(plan.script.startsWith('docker compose '), 'only a docker compose invocation');
  assert.ok(!plan.script.includes('ghcr.io'), 'the target rides CAP_VERSION, not an inline image ref');
  assert.ok(!/[;|&]\s*\w/.test(plan.script.replace(/&&/g, '')), 'no chained arbitrary command (only the && between pull/up)');
});

test('pull-then-recreate ordering: pull is FIRST, up -d SECOND, joined by &&', async () => {
  const { launcher } = capturingLauncher();
  const svc = makeService({ enabled: true, latestVersion: LATEST, launcher });

  const plan = await svc.requestUpdate(LATEST);

  assert.equal(plan.commands.length, 2, 'exactly two ordered commands');
  const [pull, up] = plan.commands;
  assert.ok(pull.includes(' pull '), 'first command pulls the new images');
  assert.ok(up.includes(' up -d '), 'second command recreates the services');
  assert.ok(
    plan.script.indexOf('pull') < plan.script.indexOf('up -d'),
    'pull precedes up -d (a failed pull leaves the prior version running)',
  );
  assert.ok(plan.script.includes(' && '), 'joined by && so up -d only runs on a successful pull');
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

function sessionPrincipal(githubId: number): OperatorPrincipal {
  return {
    kind: 'session',
    user: { githubId, login: 'op', name: 'Op', avatarUrl: '', allowed: true },
  };
}

/** The capturing launcher used by the booted service so the HTTP test never touches docker. */
const httpLauncher = capturingLauncher();
/** A mutable env the booted service reads, so a single app exercises enabled + disabled. */
const httpEnv: NodeJS.ProcessEnv = {};

let app: INestApplication;
let port: number;

before(async () => {
  // The admin allowlist names ADMIN_ID only; NON_ADMIN_ID is a logged-in operator
  // who is NOT an admin. Set on the real process.env so isAdminPrincipal (which
  // reads process.env) sees it during the HTTP request.
  process.env[SELF_UPDATE_ADMINS_ENV] = String(ADMIN_ID);

  const moduleRef = await Test.createTestingModule({
    controllers: [SelfUpdateController],
    providers: [
      {
        provide: SelfUpdateService,
        useFactory: () =>
          new SelfUpdateService(
            fakeUpdateStatus({ latestVersion: LATEST, updateAvailable: true }),
            httpLauncher.launcher,
            httpEnv,
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
  delete process.env[SELF_UPDATE_ADMINS_ENV];
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
  assert.equal(
    httpLauncher.launched().length,
    before,
    'no detached updater launched for a non-admin',
  );
});

test('HTTP: an admin on a DISABLED instance is refused 404 (env gate), no launch', async () => {
  delete httpEnv[SELF_UPDATE_ENABLED_ENV]; // disabled → inert
  currentPrincipal = sessionPrincipal(ADMIN_ID);
  const before = httpLauncher.launched().length;

  const res = await postSelfUpdate(LATEST);
  assert.equal(res.status, 404, 'a disabled instance behaves as if the endpoint is absent');
  assert.equal(
    httpLauncher.launched().length,
    before,
    'no launch on a disabled instance even for an admin',
  );
});

test('HTTP: an admin + enabled + valid target ACKS update-started and launches the detached updater', async () => {
  httpEnv[SELF_UPDATE_ENABLED_ENV] = 'true';
  currentPrincipal = sessionPrincipal(ADMIN_ID);
  const before = httpLauncher.launched().length;

  const res = await postSelfUpdate(LATEST);
  assert.equal(res.status, 202, 'the request is accepted (ack before the api restarts)');
  const body = (await res.json()) as { status: string; target: string };
  assert.equal(body.status, 'update-started', 'acks update-started');
  assert.equal(body.target, LATEST, 'acks the validated target');
  assert.equal(
    httpLauncher.launched().length,
    before + 1,
    'the detached updater was launched (no real docker — capturing launcher)',
  );
});

test('HTTP: an admin + enabled + MISMATCHED target is rejected 422, no launch', async () => {
  httpEnv[SELF_UPDATE_ENABLED_ENV] = 'true';
  currentPrincipal = sessionPrincipal(ADMIN_ID);
  const before = httpLauncher.launched().length;

  const res = await postSelfUpdate('v9.9.9');
  assert.equal(res.status, 422, 'a target that is not the reported latest is rejected');
  assert.equal(
    httpLauncher.launched().length,
    before,
    'no launch on a mismatched target',
  );
});
