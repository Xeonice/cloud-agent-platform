import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import { isAdminPrincipal } from '../auth/admin';
import {
  SelfUpdateRefusedError,
  SelfUpdateService,
} from './self-update.service';

/**
 * The `POST /self-update` request body. Kept LOCAL to this track (NOT a
 * `packages/contracts` schema), since a shared contract would be imported by both
 * api + web and become a cross-track shared file — web mirrors this shape with its
 * own local type. The only field is the upgrade `target`, which is just a
 * CONFIRMATION of the version `/update-status` already reported: the service
 * cross-checks it server-side and rejects anything that does not match (design
 * D3). It is never an arbitrary image/tag/command.
 */
interface SelfUpdateRequestBody {
  target?: unknown;
}

/** The ack returned the instant a detached updater is launched (before the api restarts). */
interface SelfUpdateAck {
  status: 'update-started';
  target: string;
}

/**
 * Self-update endpoint (self-update-action, design D1/D2/D3/D4).
 *
 * `POST /self-update` is the single, heavily-contained host-root upgrade trigger.
 * Layered containment, each enforced BEFORE any docker op:
 *
 *   1. OPERATOR GUARD (D2): the GLOBAL `APP_GUARD` `AuthGuard` already rejects any
 *      unauthenticated / de-allowlisted request with 401 before this handler runs
 *      and attaches the resolved {@link OperatorPrincipal} to the request. This
 *      route is NOT exempt, so it is operator-guarded like every protected route.
 *   2. ADMIN GATE (D2): even an authenticated operator must be an explicitly
 *      allowlisted ADMIN ({@link isAdminPrincipal} / `SELF_UPDATE_ADMINS`). A
 *      non-admin is rejected 403 — "who can press it" == "who can run as root".
 *   3. ENV GATE (D1): `SELF_UPDATE_ENABLED` default OFF → the service refuses and
 *      the handler maps it to 404, so a deployed-but-disabled instance is INERT
 *      (no live upgrade capability is exposed).
 *   4. BOUNDED TARGET (D3): the body's `target` MUST be a valid semver tag that
 *      matches `/update-status`'s latest (server-side cross-check). An invalid /
 *      mismatched target is rejected 422 — no arbitrary version can be forced.
 *
 * On a fully-valid request the service launches a DETACHED updater that pulls THEN
 * recreates ONLY the cap services and OUTLIVES this api's restart (D4); the
 * handler ACKS `update-started` the instant the updater is launched — BEFORE the
 * api goes down. The console then shows "updating… reconnecting" and the existing
 * WS auto-reconnect resumes once the new api is up; `survive-api-redeploy` keeps
 * in-flight tasks alive across the recreate.
 */
@Controller()
export class SelfUpdateController {
  constructor(private readonly selfUpdate: SelfUpdateService) {}

  @Post('self-update')
  @HttpCode(HttpStatus.ACCEPTED)
  async trigger(
    @Req() req: AuthenticatedRequest,
    @Body() body: SelfUpdateRequestBody,
  ): Promise<SelfUpdateAck> {
    // ADMIN GATE (D2). The global AuthGuard has already attached a resolved
    // operator principal (or 401'd); narrow further to an explicitly-allowlisted
    // admin. A non-admin (or the identity-less legacy bearer) is refused 403 — the
    // host-root button requires a named admin, not merely a logged-in operator.
    if (!isAdminPrincipal(req.operatorPrincipal)) {
      throw new ForbiddenException(
        'self-update requires an admin operator (SELF_UPDATE_ADMINS)',
      );
    }

    const target = typeof body?.target === 'string' ? body.target : '';

    try {
      // The service enforces the ENV gate (D1) + semver validation + the
      // /update-status cross-check (D3), then launches the DETACHED updater (D4).
      // It returns ONLY after the updater is launched, so the ack below is the
      // last thing this api does before `up -d` recreates its container.
      const plan = await this.selfUpdate.requestUpdate(target);
      return { status: 'update-started', target: plan.target };
    } catch (err) {
      if (err instanceof SelfUpdateRefusedError) {
        throw SelfUpdateController.toHttp(err);
      }
      throw err;
    }
  }

  /**
   * Map a {@link SelfUpdateRefusedError} to its HTTP refusal:
   *   - `disabled`        → 404: a disabled instance behaves as if the endpoint
   *     does not exist (design D1 — inert, no capability advertised);
   *   - `invalid-target` / `target-mismatch` → 422: the request reached an enabled
   *     instance but the bounded target check rejected it (design D3).
   * A non-admin is handled earlier (403) before the service is consulted.
   */
  private static toHttp(err: SelfUpdateRefusedError): Error {
    if (err.reason === 'disabled') {
      return new NotFoundException(err.message);
    }
    return new UnprocessableEntityException(err.message);
  }
}
