import type { Request } from 'express';

import type { OperatorPrincipal } from './operator-principal';

/**
 * An Express request after the auth guard has attached the principal.
 *
 * Consumed by sixteen directories' controllers, and it used to live inside
 * `auth/auth.guard.ts` — so every one of them imported the GUARD just to name
 * the request type it receives. The problem was never the directory; it was
 * that a widely-needed type sat inside a heavyweight module. It lives here as a
 * leaf instead.
 *
 * It stays in `auth/` deliberately. A first attempt put it under `http/`, which
 * created a NEW cycle (`auth ⟷ http`): the type is "a request carrying an
 * `OperatorPrincipal`", and the principal is an auth concept, so the type cannot
 * be described without auth. A shape that inherently names another directory's
 * concept belongs WITH that concept.
 */
export interface AuthenticatedRequest extends Request {
  operatorPrincipal?: OperatorPrincipal;
}
