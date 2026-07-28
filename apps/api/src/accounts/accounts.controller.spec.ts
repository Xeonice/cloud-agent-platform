import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';

import { AccountsController } from './accounts.controller';
import type { AccountsService } from './accounts.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';

/**
 * Admin-ness is a property of the CREDENTIAL, not only of the account behind it.
 *
 * A machine credential resolves to its OWNER's account row. If the admin gate is
 * satisfied by re-reading that row's `role`/`allowed`, then an API key or MCP
 * token minted by an admin inherits account administration — including password
 * reset and role assignment — no matter how narrow its granted scopes are. The
 * strict predicate in `../auth/admin` already states the rule ("a machine or
 * legacy principal is never an admin"); these cases hold this controller to it.
 *
 * The invariant is also written down next to the resolver: `auth.guard.ts` notes
 * that an `mcp_` token is recognised on owner-scoped REST routes "while
 * kind-gated session-only routes still reject it". Account administration is one
 * of those routes.
 */

const ADMIN_ACCOUNT_ID = 'user-admin-1';
const ADMIN_GITHUB_ID = 4242;

/** The account row the live re-read returns: enabled, and genuinely an admin. */
const ADMIN_ROW = { role: 'admin' as const, allowed: true };

function adminUser() {
  return {
    id: ADMIN_ACCOUNT_ID,
    githubId: ADMIN_GITHUB_ID,
    login: 'op',
    name: 'Op',
    avatarUrl: '',
    allowed: true,
    role: 'admin' as const,
    mustChangePassword: false,
  };
}

function sessionAdmin(): OperatorPrincipal {
  return { kind: 'session', user: adminUser() } as OperatorPrincipal;
}

/**
 * A machine principal whose OWNER is the admin. `scopes` is deliberately the
 * narrowest read-only grant: if the gate keyed on scopes it would still be wrong
 * to admit this caller, and it does not key on scopes at all.
 */
function machineOwnedByAdmin(kind: 'api-key' | 'mcp'): OperatorPrincipal {
  return {
    kind,
    user: adminUser(),
    scopes: ['tasks:read'],
  } as unknown as OperatorPrincipal;
}

function legacyPrincipal(): OperatorPrincipal {
  return { kind: 'legacy-token', user: null } as unknown as OperatorPrincipal;
}

function requestFor(principal: OperatorPrincipal | null): AuthenticatedRequest {
  return { operatorPrincipal: principal } as unknown as AuthenticatedRequest;
}

/** Records every service call so a leaked mutation is visible, not just a status. */
class RecordingAccountsService {
  calls: string[] = [];

  async list() {
    this.calls.push('list');
    return [];
  }
  async resetPassword(id: string) {
    this.calls.push(`resetPassword:${id}`);
    return {} as never;
  }
  async assignRole(id: string, role: string) {
    this.calls.push(`assignRole:${id}:${role}`);
    return {} as never;
  }
  async setEnabled(id: string, allowed: boolean) {
    this.calls.push(`setEnabled:${id}:${allowed}`);
    return {} as never;
  }
}

/** Serves the live account re-read the gate performs. */
function prismaReturning(row: { role: string; allowed: boolean } | null) {
  return {
    user: { findUnique: async () => row },
  } as unknown as PrismaService;
}

function build(row: { role: string; allowed: boolean } | null = ADMIN_ROW) {
  const accounts = new RecordingAccountsService();
  const controller = new AccountsController(
    accounts as unknown as AccountsService,
    prismaReturning(row),
  );
  return { controller, accounts };
}

async function assertForbidden(run: () => Promise<unknown>, label: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(
      error instanceof ForbiddenException,
      `${label}: expected ForbiddenException, got ${String(error)}`,
    );
    return true;
  }, label);
}

test('an API key owned by an admin cannot reset a password', async () => {
  const { controller, accounts } = build();
  await assertForbidden(
    () =>
      controller.resetPassword(
        requestFor(machineOwnedByAdmin('api-key')),
        'victim-1',
        { password: 'attacker-chosen-password' } as never,
      ),
    'api-key resetPassword',
  );
  assert.deepEqual(accounts.calls, [], 'no account mutation may be reached');
});

test('an MCP token owned by an admin cannot reset a password', async () => {
  const { controller, accounts } = build();
  await assertForbidden(
    () =>
      controller.resetPassword(
        requestFor(machineOwnedByAdmin('mcp')),
        'victim-1',
        { password: 'attacker-chosen-password' } as never,
      ),
    'mcp resetPassword',
  );
  assert.deepEqual(accounts.calls, [], 'no account mutation may be reached');
});

test('a machine credential owned by an admin cannot assign roles or list accounts', async () => {
  for (const kind of ['api-key', 'mcp'] as const) {
    const { controller, accounts } = build();
    await assertForbidden(
      () =>
        controller.assignRole(requestFor(machineOwnedByAdmin(kind)), 'victim-1', {
          role: 'admin',
        } as never),
      `${kind} assignRole`,
    );
    await assertForbidden(
      () => controller.list(requestFor(machineOwnedByAdmin(kind))),
      `${kind} list`,
    );
    assert.deepEqual(accounts.calls, [], `${kind}: nothing may be reached`);
  }
});

test('the refusal does not depend on the credential carrying narrow scopes', async () => {
  // Same owner, same route, but the credential claims every scope it could.
  const { controller } = build();
  const broadlyScoped = {
    kind: 'api-key',
    user: adminUser(),
    scopes: ['tasks:read', 'tasks:write', 'tasks:diagnostics'],
  } as unknown as OperatorPrincipal;
  await assertForbidden(
    () => controller.list(requestFor(broadlyScoped)),
    'broadly scoped api-key',
  );
});

test('a legacy shared-token principal cannot administer accounts', async () => {
  const { controller, accounts } = build();
  await assertForbidden(
    () => controller.list(requestFor(legacyPrincipal())),
    'legacy-token list',
  );
  assert.deepEqual(accounts.calls, []);
});

test('an interactive admin session is still admitted', async () => {
  const { controller, accounts } = build();
  await controller.list(requestFor(sessionAdmin()));
  assert.deepEqual(accounts.calls, ['list'], 'the control case must still work');
});

test('a demoted admin session is refused on the very next request', async () => {
  // The live re-read is what makes a mid-session demotion take effect; the kind
  // gate must not replace it.
  const { controller, accounts } = build({ role: 'member', allowed: true });
  await assertForbidden(
    () => controller.list(requestFor(sessionAdmin())),
    'demoted session',
  );
  assert.deepEqual(accounts.calls, []);
});

test('an unauthenticated request is refused', async () => {
  const { controller, accounts } = build();
  await assertForbidden(() => controller.list(requestFor(null)), 'no principal');
  assert.deepEqual(accounts.calls, []);
});
