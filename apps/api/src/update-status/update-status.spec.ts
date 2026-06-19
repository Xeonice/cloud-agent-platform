/**
 * `GET /update-status` update-availability check spec
 * (update-availability-check, Phase 2 / track api-update-status, task 2.3).
 *
 * Two complementary layers:
 *
 *  - SERVICE unit cases drive the REAL {@link UpdateStatusService} directly with
 *    an injected deterministic clock + fake {@link ReleaseFetcher} (no live
 *    GitHub, no docker), proving the spec scenarios for the comparison/degrade/
 *    cache behaviour:
 *      - update-available (current known, newer Release exists → true);
 *      - up-to-date (current == latest → false, latest still surfaced);
 *      - unknown-current (source build → false, no comparison);
 *      - no-releases (fetcher resolves null → degraded, latestVersion null);
 *      - fetch-failure (fetcher REJECTS → degraded, NEVER throws);
 *      - cache-hit (repeated calls within the TTL → ONE upstream fetch).
 *
 *  - An HTTP boot case proves the operator-guard rejection: an unauthenticated
 *    request to `/update-status` is 401'd by the SAME global {@link AuthGuard}
 *    the app wires (`auth.module.ts`), unlike the exempt `/version` — and the
 *    request never reaches the controller/service (the fetcher stays untouched).
 *
 * Run from `apps/api` with `pnpm test` (CommonJS package, no type-stripping at
 * runtime): the `pretest` hook compiles the `.spec.ts` files under `src` to
 * `.spec.js` under `dist` via `nest build`, then `node --test` executes the
 * emitted CommonJS — the same compile-then-run convention as the e2e harness.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';

import {
  UNKNOWN_VERSION_VALUE,
  VERSION_ENV_VARS,
  UpdateStatusSchema,
} from '@cap/contracts';

import { SESSION_COOKIE_NAME } from '../auth/session-token';

import {
  UpdateStatusService,
  RELEASES_REPO_ENV,
  DEFAULT_RELEASES_REPO,
  resolveCacheTtlMs,
  DEFAULT_CACHE_TTL_MS,
  MIN_CACHE_TTL_MS,
  CACHE_TTL_ENV_VAR,
  resolveReleasesApiBase,
  DEFAULT_RELEASES_API_BASE,
  RELEASES_API_BASE_ENV,
  type LatestRelease,
  type ReleaseFetcher,
} from './update-status.service';
import { UpdateStatusModule } from './update-status.module';
import { UpdateStatusService as UpdateStatusServiceToken } from './update-status.service';
import { AuthGuard } from '../auth/auth.guard';
import { AuthSessionService } from '../auth/auth-session.service';

/** A frozen clock so cache TTL math is deterministic across a test. */
function fixedClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A counting fetcher that resolves a fixed Release (or null). */
function countingFetcher(release: LatestRelease | null): {
  fetcher: ReleaseFetcher;
  calls: () => number;
} {
  let calls = 0;
  return {
    fetcher: async () => {
      calls += 1;
      return release;
    },
    calls: () => calls,
  };
}

const RELEASE: LatestRelease = {
  tag: 'v1.2.0',
  url: 'https://github.com/Xeonice/cloud-agent-platform/releases/tag/v1.2.0',
  name: 'v1.2.0 — Phase 2',
};

// ---------------------------------------------------------------------------
// Service unit scenarios
// ---------------------------------------------------------------------------

test('reports an available update when a newer Release exists (current known)', async () => {
  const { fetcher } = countingFetcher(RELEASE);
  const svc = new UpdateStatusService({
    fetcher,
    now: fixedClock().now,
    env: { [VERSION_ENV_VARS.version]: 'v1.1.0' },
  });

  const status = UpdateStatusSchema.parse(await svc.getStatus());
  assert.equal(status.updateAvailable, true, 'newer latest → updateAvailable');
  assert.equal(status.currentVersion, 'v1.1.0');
  assert.equal(status.latestVersion, 'v1.2.0');
  assert.equal(status.releaseUrl, RELEASE.url, 'carries the changelog link');
  assert.equal(status.releaseName, RELEASE.name);
});

test('up-to-date current reports no update but still surfaces the latest tag', async () => {
  const { fetcher } = countingFetcher(RELEASE);
  const svc = new UpdateStatusService({
    fetcher,
    now: fixedClock().now,
    env: { [VERSION_ENV_VARS.version]: 'v1.2.0' },
  });

  const status = UpdateStatusSchema.parse(await svc.getStatus());
  assert.equal(status.updateAvailable, false, 'equal versions → no prompt');
  assert.equal(status.currentVersion, 'v1.2.0');
  assert.equal(status.latestVersion, 'v1.2.0', 'latest is still reported honestly');
});

test('a newer current (ahead of the latest Release) reports no update', async () => {
  const { fetcher } = countingFetcher(RELEASE);
  const svc = new UpdateStatusService({
    fetcher,
    now: fixedClock().now,
    env: { [VERSION_ENV_VARS.version]: 'v2.0.0' },
  });

  const status = UpdateStatusSchema.parse(await svc.getStatus());
  assert.equal(status.updateAvailable, false, 'current ahead → no prompt');
});

test('unknown current version (source build) reports no update — no comparison', async () => {
  const { fetcher, calls } = countingFetcher(RELEASE);
  // No CAP_VERSION in env → the service resolves the "unknown" sentinel.
  const svc = new UpdateStatusService({ fetcher, now: fixedClock().now, env: {} });

  const status = UpdateStatusSchema.parse(await svc.getStatus());
  assert.equal(status.currentVersion, UNKNOWN_VERSION_VALUE, 'source build → unknown');
  assert.equal(status.updateAvailable, false, 'unknown current → never a prompt');
  assert.ok(calls() >= 0, 'no throw');
});

test('no published Release (fetcher resolves null) degrades honestly', async () => {
  const { fetcher } = countingFetcher(null);
  const svc = new UpdateStatusService({
    fetcher,
    now: fixedClock().now,
    env: { [VERSION_ENV_VARS.version]: 'v1.1.0' },
  });

  const status = UpdateStatusSchema.parse(await svc.getStatus());
  assert.equal(status.updateAvailable, false, 'no releases → no prompt');
  assert.equal(status.latestVersion, null, 'degraded: latest null');
  assert.equal(status.releaseUrl, null);
  assert.equal(status.releaseName, null);
  assert.equal(status.currentVersion, 'v1.1.0', 'current still reported');
});

test('a fetch failure degrades (never throws)', async () => {
  let calls = 0;
  const fetcher: ReleaseFetcher = async () => {
    calls += 1;
    throw new Error('network down');
  };
  const svc = new UpdateStatusService({
    fetcher,
    now: fixedClock().now,
    env: { [VERSION_ENV_VARS.version]: 'v1.1.0' },
  });

  // The whole point: getStatus resolves a degraded status rather than rejecting.
  const status = UpdateStatusSchema.parse(await svc.getStatus());
  assert.equal(status.updateAvailable, false, 'fetch failure → no prompt');
  assert.equal(status.latestVersion, null, 'degraded: latest null');
  assert.equal(calls, 1, 'the fetcher was attempted');
});

test('a transient fetch failure is not cached — the next request retries', async () => {
  let calls = 0;
  const fetcher: ReleaseFetcher = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('transient');
    }
    return RELEASE;
  };
  const svc = new UpdateStatusService({
    fetcher,
    now: fixedClock().now,
    env: { [VERSION_ENV_VARS.version]: 'v1.1.0' },
  });

  const first = await svc.getStatus();
  assert.equal(first.updateAvailable, false, 'first (failed) → degraded');
  const second = await svc.getStatus();
  assert.equal(second.updateAvailable, true, 'retry succeeds, not stuck on the failure');
  assert.equal(calls, 2, 'a failed lookup is retried, not cached');
});

test('the lookup is cached within the TTL — one upstream fetch across requests', async () => {
  const clock = fixedClock();
  const { fetcher, calls } = countingFetcher(RELEASE);
  const svc = new UpdateStatusService({
    fetcher,
    now: clock.now,
    cacheTtlMs: 60_000,
    env: { [VERSION_ENV_VARS.version]: 'v1.1.0' },
  });

  await svc.getStatus();
  await svc.getStatus();
  clock.advance(59_000); // still within the TTL
  await svc.getStatus();
  assert.equal(calls(), 1, 'one upstream fetch served three requests within the TTL');

  clock.advance(2_000); // now past the TTL (61s elapsed > 60s)
  await svc.getStatus();
  assert.equal(calls(), 2, 'a request past the TTL refreshes the cache');
});

test('concurrent requests within the TTL coalesce onto a single fetch', async () => {
  const clock = fixedClock();
  const { fetcher, calls } = countingFetcher(RELEASE);
  const svc = new UpdateStatusService({
    fetcher,
    now: clock.now,
    cacheTtlMs: 60_000,
    env: { [VERSION_ENV_VARS.version]: 'v1.1.0' },
  });

  // Fire both before either resolves — they must share one in-flight lookup.
  const [a, b] = await Promise.all([svc.getStatus(), svc.getStatus()]);
  assert.equal(a.updateAvailable, true);
  assert.equal(b.updateAvailable, true);
  assert.equal(calls(), 1, 'concurrent callers coalesce to one upstream fetch');
});

test('an unparseable latest tag never fabricates a prompt', async () => {
  const { fetcher } = countingFetcher({ tag: 'nightly-build', url: null, name: null });
  const svc = new UpdateStatusService({
    fetcher,
    now: fixedClock().now,
    env: { [VERSION_ENV_VARS.version]: 'v1.1.0' },
  });

  const status = UpdateStatusSchema.parse(await svc.getStatus());
  assert.equal(status.updateAvailable, false, 'unparseable tag → no prompt');
  assert.equal(status.latestVersion, 'nightly-build', 'tag still surfaced honestly');
});

test('the checked repo defaults to the cap repo and honours GITHUB_RELEASES_REPO', async () => {
  let seen: string | undefined;
  const fetcher: ReleaseFetcher = async (repo) => {
    seen = repo;
    return RELEASE;
  };

  await new UpdateStatusService({
    fetcher,
    now: fixedClock().now,
    env: { [VERSION_ENV_VARS.version]: 'v1.1.0' },
  }).getStatus();
  assert.equal(seen, DEFAULT_RELEASES_REPO, 'defaults to the cap repo');

  await new UpdateStatusService({
    fetcher,
    now: fixedClock().now,
    env: {
      [VERSION_ENV_VARS.version]: 'v1.1.0',
      [RELEASES_REPO_ENV]: 'me/my-fork',
    },
  }).getStatus();
  assert.equal(seen, 'me/my-fork', 'honours the configured repo');
});

// ---------------------------------------------------------------------------
// Near-live cache TTL (responsive-update-check D1)
// ---------------------------------------------------------------------------

test('cache TTL: explicit option wins and bypasses the floor (tests need sub-second TTLs)', () => {
  assert.equal(resolveCacheTtlMs(500, {}), 500, 'explicit value used as-is, no floor');
});

test('cache TTL: UPDATE_CHECK_CACHE_TTL_MS env is honoured', () => {
  assert.equal(
    resolveCacheTtlMs(undefined, { [CACHE_TTL_ENV_VAR]: '120000' }),
    120000,
    'env ms value drives the TTL',
  );
});

test('cache TTL: a below-floor env value is clamped to the 60s floor', () => {
  assert.equal(
    resolveCacheTtlMs(undefined, { [CACHE_TTL_ENV_VAR]: '1000' }),
    MIN_CACHE_TTL_MS,
    'a misconfigured low value cannot exceed GitHub anonymous rate limit',
  );
});

test('cache TTL: unset/invalid env falls back to the short (minutes-scale) default', () => {
  assert.equal(resolveCacheTtlMs(undefined, {}), DEFAULT_CACHE_TTL_MS);
  assert.equal(resolveCacheTtlMs(undefined, { [CACHE_TTL_ENV_VAR]: 'abc' }), DEFAULT_CACHE_TTL_MS);
  assert.ok(DEFAULT_CACHE_TTL_MS <= 10 * 60 * 1000, 'default is minutes-scale, not hours');
});

test('the env-configured TTL drives the service cache (refresh after it elapses)', async () => {
  const clock = fixedClock();
  const { fetcher, calls } = countingFetcher(RELEASE);
  const svc = new UpdateStatusService({
    fetcher,
    now: clock.now,
    env: { [VERSION_ENV_VARS.version]: 'v1.1.0', [CACHE_TTL_ENV_VAR]: '120000' },
  });
  await svc.getStatus();
  clock.advance(119_000); // within the 120s env TTL
  await svc.getStatus();
  assert.equal(calls(), 1, 'served from cache within the env TTL');
  clock.advance(2_000); // past 120s
  await svc.getStatus();
  assert.equal(calls(), 2, 'refreshes once the env TTL elapses');
});

// ---------------------------------------------------------------------------
// Release-lookup upstream base (mirror-release-checks-via-worker D4)
// ---------------------------------------------------------------------------

test('resolveReleasesApiBase: defaults to the mirror, honours GITHUB_API_BASE, strips trailing slash', () => {
  assert.equal(resolveReleasesApiBase({}), DEFAULT_RELEASES_API_BASE, 'unset → mirror default');
  assert.equal(
    resolveReleasesApiBase({ [RELEASES_API_BASE_ENV]: 'https://api.github.com' }),
    'https://api.github.com',
    'escape hatch → direct GitHub',
  );
  assert.equal(
    resolveReleasesApiBase({ [RELEASES_API_BASE_ENV]: 'https://api.github.com/' }),
    'https://api.github.com',
    'a trailing slash is stripped so the path joins cleanly',
  );
  assert.equal(
    resolveReleasesApiBase({ [RELEASES_API_BASE_ENV]: '   ' }),
    DEFAULT_RELEASES_API_BASE,
    'blank → mirror default',
  );
});

test('the release lookup targets the mirror by default and the escape hatch when set', async () => {
  let seenBase: string | undefined;
  const baseRecordingFetcher: ReleaseFetcher = async (_repo, apiBase) => {
    seenBase = apiBase;
    return RELEASE;
  };

  await new UpdateStatusService({
    fetcher: baseRecordingFetcher,
    now: fixedClock().now,
    env: { [VERSION_ENV_VARS.version]: 'v1.1.0' },
  }).getStatus();
  assert.equal(seenBase, DEFAULT_RELEASES_API_BASE, 'default routes the lookup through the mirror');

  await new UpdateStatusService({
    fetcher: baseRecordingFetcher,
    now: fixedClock().now,
    env: {
      [VERSION_ENV_VARS.version]: 'v1.1.0',
      [RELEASES_API_BASE_ENV]: 'https://api.github.com',
    },
  }).getStatus();
  assert.equal(seenBase, 'https://api.github.com', 'the escape hatch targets GitHub directly');
});

// ---------------------------------------------------------------------------
// Operator-guard rejection (live HTTP boot, same global AuthGuard as the app)
// ---------------------------------------------------------------------------

/** Records whether the controller/service was reached past the guard. */
let serviceFetchCalls = 0;
/** Records whether the guard's session resolver was reached. */
let resolveSessionCalls = 0;

const authSessionStub: Pick<AuthSessionService, 'resolveSession'> = {
  async resolveSession() {
    resolveSessionCalls += 1;
    return null; // never a valid principal → the guard rejects
  },
};

let app: INestApplication;
let port: number;

before(async () => {
  const guardFetcher: ReleaseFetcher = async () => {
    serviceFetchCalls += 1;
    return RELEASE;
  };

  const moduleRef = await Test.createTestingModule({
    imports: [UpdateStatusModule],
    providers: [
      { provide: AuthSessionService, useValue: authSessionStub },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  })
    // Replace the production factory-built service with one whose fetch is
    // observable, so we can prove the handler is NEVER reached on a 401.
    .overrideProvider(UpdateStatusServiceToken)
    .useValue(
      new UpdateStatusService({
        fetcher: guardFetcher,
        env: { [VERSION_ENV_VARS.version]: 'v1.1.0' },
      }),
    )
    .compile();

  app = moduleRef.createNestApplication();
  await app.listen(0);
  const address = app.getHttpServer().address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  await app?.close();
});

test('GET /update-status is operator-guarded — unauthenticated request is 401', async () => {
  serviceFetchCalls = 0;

  // No cookie / Authorization header: an unauthenticated operator request.
  const res = await fetch(`http://127.0.0.1:${port}/update-status`);
  assert.equal(res.status, 401, 'rejected by the global operator-auth guard');

  assert.equal(
    serviceFetchCalls,
    0,
    'the guard rejects BEFORE the handler — no outbound GitHub fetch is triggered',
  );
});

test('GET /update-status is GATED (not guard-exempt like /version) — a presented session is resolved', async () => {
  resolveSessionCalls = 0;
  serviceFetchCalls = 0;

  // A request carrying a (bogus) session cookie: an exempt path would short-
  // circuit in canActivate WITHOUT resolving the session. /update-status is NOT
  // exempt, so the guard actively resolves the session — which returns null
  // (invalid) → still 401, and the handler is never reached.
  const res = await fetch(`http://127.0.0.1:${port}/update-status`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-token` },
  });
  assert.equal(res.status, 401, 'invalid session still rejected');
  assert.ok(
    resolveSessionCalls >= 1,
    '/update-status is gated — the guard resolved the presented session (unlike exempt /version)',
  );
  assert.equal(serviceFetchCalls, 0, 'handler never reached on a 401');
});
