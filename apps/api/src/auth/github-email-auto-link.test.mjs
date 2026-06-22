/**
 * Minimal ground-truth test: "GitHub login auto-links by verified primary email"
 * (add-private-account-identity, requirement D8).
 *
 * Requirement (verbatim spec comment in auth-session.service.ts, step 2b / D8):
 *   When a GitHub identity is seen for the FIRST TIME and the GitHub service
 *   returns a PRIMARY+VERIFIED email that matches an existing User.email, the
 *   orchestrator SHALL auto-link the github IdentityLink to that account — it
 *   MUST NOT provision a brand-new account. An audit event SHALL be emitted.
 *   When no email match is found (no verified email, or no existing user with
 *   that email), a fresh account IS provisioned instead (normal path).
 *
 * Scenarios:
 *   AL1 — Auto-link path: github identity is new, verified email matches an
 *          existing User → THAT user is linked, no new User created, audit fires.
 *   AL2 — No-match path: github identity is new, verified email present but NO
 *          existing User has that email → fresh User provisioned.
 *   AL3 — No-email path: github identity is new, email is null → fresh User
 *          provisioned (no auto-link attempted).
 *
 * Runs against the REAL compiled dist so this is true ground truth.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../../dist/auth');

const { AuthSessionService } = require(path.join(DIST, 'auth-session.service.js'));

// ── minimal fake Prisma ───────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object|null} opts.existingUserByEmail  — the User row returned when
 *   prisma.user.findUnique({ where: { email } }) is called (auto-link target).
 *   null = no matching user → fresh provision.
 */
function makePrisma({ existingUserByEmail = null } = {}) {
  const calls = {
    userCreate: [],
    userUpdate: [],
    identityLinkUpsert: [],
    auditRecordIdentityLinked: [],
  };

  return {
    calls,
    identityLink: {
      // No existing github identity — every scenario here is a FIRST login.
      findUnique: async () => null,
      upsert: async (args) => {
        calls.identityLinkUpsert.push(args);
        return {};
      },
    },
    user: {
      // Called with { where: { email } } for the auto-link probe.
      findUnique: async ({ where }) => {
        if (where?.email) return existingUserByEmail;
        return null;
      },
      create: async ({ data }) => {
        const id = `new-user-${calls.userCreate.length + 1}`;
        calls.userCreate.push({ id, data });
        return { id };
      },
      update: async ({ where, data }) => {
        calls.userUpdate.push({ where, data });
        return { id: where.id };
      },
      findUniqueOrThrow: async () => ({ role: 'member', mustChangePassword: false }),
    },
    session: {
      create: async () => ({}),
    },
  };
}

/** GitHub user fixture — new identity (no existing IdentityLink). */
const makeGithubUser = (id, email) => ({
  id,
  login: `user-${id}`,
  name: `User ${id}`,
  avatarUrl: `https://avatar/${id}`,
  email,
});

const ENV_ALLOWLIST = (id) => ({ AUTH_ALLOWLIST: String(id) });

// ── harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// ── scenarios ─────────────────────────────────────────────────────────────────

const run = async () => {
  console.log('\n=== Requirement: GitHub login auto-links by verified primary email ===\n');

  // ── AL1: auto-link path ──────────────────────────────────────────────────────
  // A new GitHub identity whose verified email matches an existing User.email
  // should attach to THAT user, not create a new one.
  {
    const EXISTING_USER_ID = 'user-already-registered-via-email';
    const VERIFIED_EMAIL = 'operator@example.com';

    // auditService double — records every recordIdentityLinked call.
    const auditCalls = [];
    const auditService = {
      recordIdentityLinked: (args) => auditCalls.push(args),
    };

    const prisma = makePrisma({
      existingUserByEmail: { id: EXISTING_USER_ID },
    });
    const svc = new AuthSessionService(prisma, auditService);

    const githubUser = makeGithubUser(55001, VERIFIED_EMAIL);
    const result = await svc.establishSessionForGitHubUser(
      githubUser,
      'gh-access-token-AL1',
      ENV_ALLOWLIST(githubUser.id),
    );

    assert(result !== null, 'AL1a: auto-link path: session is established');

    // No new User created — the existing user is linked.
    assert(
      prisma.calls.userCreate.length === 0,
      'AL1b: auto-link: NO new User row created (existing account linked)',
    );

    // The existing user's profile is updated (login/name/avatar/allowed).
    const updates = prisma.calls.userUpdate;
    assert(updates.length >= 1, 'AL1c: auto-link: existing User is updated (profile refresh)');
    const linkedUpdate = updates.find((u) => u.where?.id === EXISTING_USER_ID);
    assert(
      linkedUpdate !== undefined,
      `AL1d: auto-link: update targets the EXISTING user id "${EXISTING_USER_ID}"`,
    );
    assert(
      linkedUpdate?.data?.login === githubUser.login,
      'AL1e: auto-link: existing user login field refreshed to GitHub login',
    );

    // The IdentityLink for github:55001 is created (upserted) pointing to the
    // existing user, not a new one.
    const linkUpsert = prisma.calls.identityLinkUpsert.find(
      (u) =>
        u.where?.provider_providerAccountId?.provider === 'github' &&
        u.where?.provider_providerAccountId?.providerAccountId === String(githubUser.id),
    );
    assert(
      linkUpsert !== undefined,
      'AL1f: auto-link: IdentityLink upsert issued for provider="github"',
    );
    assert(
      linkUpsert?.create?.userId === EXISTING_USER_ID,
      `AL1g: auto-link: IdentityLink.userId = existing user "${EXISTING_USER_ID}", not a new one`,
    );

    // Audit event fired with the correct fields.
    assert(auditCalls.length === 1, 'AL1h: auto-link: audit.recordIdentityLinked called exactly once');
    assert(
      auditCalls[0]?.userId === EXISTING_USER_ID,
      'AL1i: audit event carries the existing userId',
    );
    assert(
      auditCalls[0]?.provider === 'github',
      'AL1j: audit event carries provider="github"',
    );
    assert(
      auditCalls[0]?.providerAccountId === String(githubUser.id),
      'AL1k: audit event carries the numeric github id as providerAccountId',
    );
    assert(
      auditCalls[0]?.email === VERIFIED_EMAIL,
      'AL1l: audit event carries the verified email that triggered the link',
    );
  }

  // ── AL2: no-match path (verified email, but no existing user with that email) ─
  // Should provision a FRESH account, not crash or auto-link to nothing.
  {
    const VERIFIED_EMAIL = 'brand-new@example.com';

    const auditCalls = [];
    const auditService = { recordIdentityLinked: (a) => auditCalls.push(a) };

    const prisma = makePrisma({ existingUserByEmail: null }); // no match
    const svc = new AuthSessionService(prisma, auditService);

    const githubUser = makeGithubUser(55002, VERIFIED_EMAIL);
    const result = await svc.establishSessionForGitHubUser(
      githubUser,
      'gh-access-token-AL2',
      ENV_ALLOWLIST(githubUser.id),
    );

    assert(result !== null, 'AL2a: no-email-match path: session is established');
    assert(
      prisma.calls.userCreate.length === 1,
      'AL2b: no-email-match: a fresh User is provisioned (one create)',
    );
    assert(
      prisma.calls.userCreate[0]?.data?.login === githubUser.login,
      'AL2c: no-email-match: fresh user captures github login',
    );
    assert(
      prisma.calls.userCreate[0]?.data?.email === VERIFIED_EMAIL,
      'AL2d: no-email-match: fresh user captures the verified email',
    );
    // No audit event — auto-link did not fire.
    assert(
      auditCalls.length === 0,
      'AL2e: no-email-match: audit.recordIdentityLinked NOT called (no link)',
    );
  }

  // ── AL3: no-email path (GitHub returns null for email) ───────────────────────
  // Should provision a fresh account; no auto-link attempted.
  {
    const auditCalls = [];
    const auditService = { recordIdentityLinked: (a) => auditCalls.push(a) };

    // existingUserByEmail should never even be probed when email is null,
    // but we supply one to confirm it is NOT used.
    const prisma = makePrisma({ existingUserByEmail: { id: 'should-not-be-linked' } });
    const svc = new AuthSessionService(prisma, auditService);

    const githubUser = makeGithubUser(55003, null); // null email
    const result = await svc.establishSessionForGitHubUser(
      githubUser,
      'gh-access-token-AL3',
      ENV_ALLOWLIST(githubUser.id),
    );

    assert(result !== null, 'AL3a: null-email path: session is established');
    assert(
      prisma.calls.userCreate.length === 1,
      'AL3b: null-email: a fresh User is provisioned (no auto-link without email)',
    );
    assert(
      auditCalls.length === 0,
      'AL3c: null-email: audit.recordIdentityLinked NOT called (no email → no link)',
    );
    // The fresh user must NOT be linked to the existing-by-email stub.
    const linkedToWrongUser = prisma.calls.userUpdate.some(
      (u) => u.where?.id === 'should-not-be-linked',
    );
    assert(
      !linkedToWrongUser,
      'AL3d: null-email: the email-matched user is NOT updated (auto-link not triggered)',
    );
  }

  // ── summary ───────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('ALL TESTS PASSED');
    process.exit(0);
  } else {
    console.error('SOME TESTS FAILED');
    process.exit(1);
  }
};

void run();
