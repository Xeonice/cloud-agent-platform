/**
 * `GET /v1/openapi.json` + `GET /v1/docs` auth-exemption spec
 * (public-v1-api, Track `openapi`, task 4.3).
 *
 * In-process NestJS test in the same style as the `/version` exemption spec
 * (`apps/api/src/health/version.controller.spec.ts`): boot a real Nest HTTP app
 * via `@nestjs/testing`, register the SAME global {@link AuthGuard} the app
 * wires, and `fetch` the endpoints over HTTP. It proves the two spec scenarios:
 *
 *   - `GET /v1/openapi.json` and `GET /v1/docs` are reachable with NO operator
 *     credential (exempted in `auth.guard.ts`, exactly like `/version`), and the
 *     spec is a valid OpenAPI 3.1 document while the docs page is HTML; AND
 *   - a `/v1` DATA route (`GET /v1/tasks`) stays 401 without a credential — the
 *     exemption is exact-match on the docs/spec endpoints only, never the data
 *     surface.
 *
 * The guard's only collaborator ({@link AuthSessionService}) is replaced with a
 * stub that records whether it was reached: a request to an EXEMPT path must
 * short-circuit in `canActivate` before any session resolution (so the stub
 * stays untouched on the exempt hits), while the DATA route MUST reach it and be
 * rejected.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { Controller, Get } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

import { OpenApiController } from './openapi.controller';
import { AuthGuard } from '../auth/auth.guard';
import { AuthSessionService } from '../auth/auth-session.service';

/** Records how many times the guard's session resolver was reached. */
let resolveSessionCalls = 0;

/**
 * Stand-in for {@link AuthSessionService}. A reachable EXEMPT path must NEVER
 * resolve a session; a guarded DATA route MUST. Returning `null` here means the
 * guarded route is rejected 401 (no valid principal), which is exactly what the
 * 401 scenario asserts.
 */
const authSessionStub: Pick<AuthSessionService, 'resolveSession'> = {
  async resolveSession() {
    resolveSessionCalls += 1;
    return null;
  },
};

/**
 * Minimal stand-in for a `/v1` DATA controller, so the guard runs against a real
 * `/v1/tasks` route. Its handler must NEVER execute for an unauthenticated
 * request — the guard rejects first — so reaching the body is a regression.
 */
@Controller('v1')
class StubV1DataController {
  @Get('tasks')
  list(): never {
    throw new Error('guarded /v1 data route reached without a credential');
  }
}

let app: INestApplication;
let port: number;

before(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [OpenApiController, StubV1DataController],
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
});

const url = (path: string) => `http://127.0.0.1:${port}${path}`;

test('GET /v1/openapi.json is reachable unauthenticated and is OpenAPI 3.1', async () => {
  // No Authorization header / session cookie: the request is unauthenticated.
  const res = await fetch(url('/v1/openapi.json'));
  assert.equal(res.status, 200, 'served unauthenticated (guard-exempt)');
  assert.match(
    res.headers.get('content-type') ?? '',
    /application\/json/,
    'served as JSON',
  );

  const doc = await res.json();
  assert.equal(doc.openapi, '3.1.0', 'is an OpenAPI 3.1 document');
  assert.ok(doc.paths && typeof doc.paths === 'object', 'has a paths object');

  assert.equal(
    resolveSessionCalls,
    0,
    '/v1/openapi.json must be guard-exempt — no session resolution',
  );
});

test('GET /v1/docs is reachable unauthenticated and serves Swagger UI HTML', async () => {
  const res = await fetch(url('/v1/docs'));
  assert.equal(res.status, 200, 'served unauthenticated (guard-exempt)');
  assert.match(
    res.headers.get('content-type') ?? '',
    /text\/html/,
    'served as HTML',
  );

  const html = await res.text();
  assert.match(html, /swagger-ui/i, 'renders Swagger UI');
  assert.match(html, /\/v1\/openapi\.json/, 'points at the spec endpoint');

  assert.equal(
    resolveSessionCalls,
    0,
    '/v1/docs must be guard-exempt — no session resolution',
  );
});

test('GET /v1/tasks (a /v1 DATA route) stays 401 without a credential', async () => {
  // Present a (bogus) session cookie so the guard runs the FULL principal
  // resolution for this data route — exercising `resolveSession` — and still
  // rejects. This proves the docs/spec exemption is exact-match: `/v1/tasks` is
  // NOT short-circuited as exempt; it reaches the resolver and is denied. (With no
  // credential at all the resolver is never invoked because there is no token to
  // resolve — `resolveOperatorPrincipal` returns null up front — so the cookie is
  // what makes "the guard ran the resolver" observable here.)
  const res = await fetch(url('/v1/tasks'), {
    headers: { cookie: 'cap_session=not-a-real-session' },
  });
  assert.equal(
    res.status,
    401,
    'the exemption is exact-match on docs/spec only — data routes stay guarded',
  );

  assert.equal(
    resolveSessionCalls,
    1,
    'the guarded data route reached the resolver (and was rejected: stub returns null)',
  );
});
