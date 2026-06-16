/**
 * `GET /version` unauthenticated build-metadata endpoint spec
 * (versioned-release-pipeline, design D1 / track api-version, task 1.4).
 *
 * In-process NestJS test in the same style as the e2e `A. health` case
 * (`apps/api/test/api-e2e.mjs`): boot a real Nest HTTP app via
 * `@nestjs/testing`, register the SAME global {@link AuthGuard} the app wires
 * (`auth.module.ts`), and `fetch` the endpoint over HTTP. It proves the three
 * spec scenarios:
 *   - `/version` reports the build metadata injected via `process.env`
 *     (`CAP_VERSION` / `GIT_SHA` / `BUILD_TIME`);
 *   - it degrades HONESTLY to `"unknown"` for any field not injected (a plain
 *     source build with no build args);
 *   - it is served UNAUTHENTICATED — exempt from the operator guard exactly like
 *     `/health` — so no operator principal is ever resolved.
 *
 * The guard's only collaborator ({@link AuthSessionService}) is replaced with a
 * stub that FAILS the test if reached: a request to an exempt path must
 * short-circuit in `canActivate` before any session resolution, so the stub
 * staying untouched is itself the auth-exemption assertion.
 */
import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';

import {
  UNKNOWN_VERSION_VALUE,
  VERSION_ENV_VARS,
  VersionResponseSchema,
} from '@cap/contracts';

import { HealthModule } from './health.module';
import { AuthGuard } from '../auth/auth.guard';
import { AuthSessionService } from '../auth/auth-session.service';

/** Records whether the guard's session resolver was reached at all. */
let resolveSessionCalls = 0;

/**
 * Stand-in for {@link AuthSessionService}. A reachable `/version` must NEVER
 * resolve a session (it is guard-exempt), so any call here is a regression and
 * is surfaced via {@link resolveSessionCalls}.
 */
const authSessionStub: Pick<AuthSessionService, 'resolveSession'> = {
  async resolveSession() {
    resolveSessionCalls += 1;
    return null;
  },
};

let app: INestApplication;
let port: number;

/** Snapshot the version env vars so each case sets them in isolation. */
const VERSION_ENV_KEYS = Object.values(VERSION_ENV_VARS);
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [HealthModule],
    providers: [
      { provide: AuthSessionService, useValue: authSessionStub },
      { provide: APP_GUARD, useClass: AuthGuard },
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

beforeEach(() => {
  resolveSessionCalls = 0;
  for (const key of VERSION_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of VERSION_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

const versionUrl = () => `http://127.0.0.1:${port}/version`;

test('/version reports injected build metadata, unauthenticated', async () => {
  process.env[VERSION_ENV_VARS.version] = 'v1.2.3';
  process.env[VERSION_ENV_VARS.gitSha] = 'abc1234';
  process.env[VERSION_ENV_VARS.buildTime] = '2026-06-17T00:00:00Z';

  // No Authorization header / session cookie: the request is unauthenticated.
  const res = await fetch(versionUrl());
  assert.equal(res.status, 200, 'served unauthenticated (guard-exempt)');

  const body = await res.json();
  assert.deepEqual(VersionResponseSchema.parse(body), {
    version: 'v1.2.3',
    gitSha: 'abc1234',
    buildTime: '2026-06-17T00:00:00Z',
  });

  assert.equal(
    resolveSessionCalls,
    0,
    '/version must be guard-exempt — no session resolution',
  );
});

test('/version degrades to "unknown" for un-injected fields', async () => {
  // Only CAP_VERSION injected; the other two fields fall back honestly.
  process.env[VERSION_ENV_VARS.version] = 'v9.9.9';

  const res = await fetch(versionUrl());
  assert.equal(res.status, 200);

  assert.deepEqual(await res.json(), {
    version: 'v9.9.9',
    gitSha: UNKNOWN_VERSION_VALUE,
    buildTime: UNKNOWN_VERSION_VALUE,
  });
});

test('/version reports all "unknown" for a no-arg source build', async () => {
  // beforeEach already cleared every version env var — a plain source build.
  const res = await fetch(versionUrl());
  assert.equal(res.status, 200, 'reports honestly rather than erroring');

  assert.deepEqual(await res.json(), {
    version: UNKNOWN_VERSION_VALUE,
    gitSha: UNKNOWN_VERSION_VALUE,
    buildTime: UNKNOWN_VERSION_VALUE,
  });
});
