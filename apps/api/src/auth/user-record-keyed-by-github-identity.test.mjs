/**
 * Minimal test for requirement: "User record keyed by GitHub identity"
 * (add-private-account-identity, multi-user-oauth spec).
 *
 * Scenarios covered:
 *   S1 — First GitHub login creates a User row AND a github IdentityLink keyed on
 *         the stable numeric GitHub id, capturing login/name/avatar/email.
 *   S2 — Subsequent login (existing IdentityLink found) refreshes mutable profile
 *         fields (login, avatarUrl) WITHOUT creating a duplicate User or identity row.
 *   S3 — Record creation never substitutes for the gate: a non-allowlisted identity
 *         gets NO User row and NO IdentityLink row (the gate is first).
 *
 * Uses the REAL compiled dist to exercise the actual code path, with an in-memory
 * fake Prisma that records creation calls so we can assert the keying invariants.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../../dist/auth');

const { AuthSessionService } = require(path.join(DIST, 'auth-session.service.js'));

// ── fake Prisma ────────────────────────────────────────────────────────────────

/**
 * Build a minimal in-memory Prisma double that records the calls the service
 * makes to user / identityLink / session delegates.
 *
 * @param {object} opts
 * @param {object|null} opts.existingIdentityLink - pre-seeded github IdentityLink row
 *   (simulates a returning user); null = first login.
 * @param {object|null} opts.existingUserByEmail  - pre-seeded User row matched by
 *   verified email for the auto-link path; null = not present.
 */
function makePrisma({ existingIdentityLink = null, existingUserByEmail = null } = {}) {
  const calls = {
    userCreate: [],
    userUpdate: [],
    identityLinkFindUnique: [],
    identityLinkUpsert: [],
    sessionCreate: 0,
  };

  // Simulated in-memory user store.
  const userStore = {};
  const identityLinkStore = {};

  return {
    calls,
    user: {
      findUnique: async ({ where }) => {
        if (where?.email) {
          return existingUserByEmail;
        }
        if (where?.id) {
          return userStore[where.id] ?? null;
        }
        return null;
      },
      create: async ({ data, select }) => {
        const id = `user-${Object.keys(userStore).length + 1}`;
        userStore[id] = { id, ...data };
        calls.userCreate.push({ id, data });
        return select ? { id } : userStore[id];
      },
      update: async ({ where, data, select }) => {
        const existing = userStore[where.id] ?? { id: where.id };
        const updated = { ...existing, ...data };
        userStore[where.id] = updated;
        calls.userUpdate.push({ where, data });
        return select ? { id: where.id } : updated;
      },
    },
    identityLink: {
      findUnique: async ({ where }) => {
        calls.identityLinkFindUnique.push(where);
        // key: "provider:providerAccountId"
        const key = `${where.provider_providerAccountId.provider}:${where.provider_providerAccountId.providerAccountId}`;
        return identityLinkStore[key] ?? existingIdentityLink;
      },
      findFirst: async ({ where }) => {
        // Used by getGithubTokenForUser in setGithubTokenForUser path.
        return null;
      },
      upsert: async ({ where, create, update }) => {
        const key = `${where.provider_providerAccountId.provider}:${where.provider_providerAccountId.providerAccountId}`;
        calls.identityLinkUpsert.push({ where, create, update });
        const existing = identityLinkStore[key];
        if (existing) {
          identityLinkStore[key] = { ...existing, ...update };
        } else {
          identityLinkStore[key] = { id: `link-${key}`, ...create };
        }
        return identityLinkStore[key];
      },
    },
    session: {
      create: async () => {
        calls.sessionCreate += 1;
        return {};
      },
      findFirst: async () => null,
      deleteMany: async () => ({ count: 0 }),
    },
  };
}

const makeGithubUser = (id, { login = 'octocat', name = 'The Octocat', avatarUrl = 'https://avatar', email = null } = {}) =>
  ({ id, login, name, avatarUrl, email });

// Stub AuditService (only recordIdentityLinked is called on auto-link path)
const stubAudit = { recordIdentityLinked: () => {} };

// ── harness ────────────────────────────────────────────────────────────────────

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
  console.log('\n=== Requirement: User record keyed by GitHub identity ===\n');

  // S1: First login — new User + new github IdentityLink, keyed on numeric id.
  {
    const prisma = makePrisma({ existingIdentityLink: null });
    const svc = new AuthSessionService(prisma, stubAudit);
    const githubUser = makeGithubUser(12345, { login: 'octocat', email: 'oct@example.com' });

    const result = await svc.establishSessionForGitHubUser(
      githubUser,
      'gh-access-token-abc',
      { AUTH_ALLOWLIST: '12345' },
    );

    assert(result !== null, 'S1a: admitted github identity obtains a session');
    assert(prisma.calls.userCreate.length === 1,
      'S1b: first login creates exactly one User row');

    const createdUser = prisma.calls.userCreate[0];
    assert(createdUser?.data?.login === 'octocat',
      'S1c: User row captures the github login');
    assert(createdUser?.data?.name === 'The Octocat',
      'S1d: User row captures the display name');
    assert(createdUser?.data?.avatarUrl === 'https://avatar',
      'S1e: User row captures the avatar reference');
    assert(createdUser?.data?.email === 'oct@example.com',
      'S1f: User row captures the verified email when present');

    assert(prisma.calls.identityLinkUpsert.length === 1,
      'S1g: exactly one IdentityLink upsert on first login');

    const upsert = prisma.calls.identityLinkUpsert[0];
    assert(upsert?.where?.provider_providerAccountId?.provider === 'github',
      'S1h: IdentityLink keyed with provider = "github"');
    assert(upsert?.where?.provider_providerAccountId?.providerAccountId === '12345',
      'S1i: IdentityLink keyed on the NUMERIC github id (as string), not the login');

    // The create payload must carry the userId that was just created.
    const createdUserId = prisma.calls.userCreate[0]?.id;
    assert(upsert?.create?.userId === createdUserId,
      'S1j: IdentityLink.userId references the newly created User');
  }

  // S2: Subsequent login — existing IdentityLink found → User updated (profile
  //     refresh), NO duplicate User created, NO new IdentityLink row.
  {
    const existingUserId = 'existing-user-id-99';
    // Simulate that an IdentityLink for github:12345 already exists in the DB.
    const existingLink = { id: 'link-1', userId: existingUserId, provider: 'github', providerAccountId: '12345', secret: null };

    const prisma = makePrisma({ existingIdentityLink: existingLink });
    const svc = new AuthSessionService(prisma, stubAudit);

    // Simulate the user store already having the existing user.
    prisma.user['__store__'] = {};
    // Pre-populate by calling update stub manually is not needed; update will upsert.

    const githubUserUpdated = makeGithubUser(12345, {
      login: 'octocat-renamed',  // login changed
      avatarUrl: 'https://new-avatar',
      email: 'oct@example.com',
    });

    const result = await svc.establishSessionForGitHubUser(
      githubUserUpdated,
      'gh-access-token-def',
      { AUTH_ALLOWLIST: '12345' },
    );

    assert(result !== null, 'S2a: returning github identity obtains a session');
    assert(prisma.calls.userCreate.length === 0,
      'S2b: no new User row created on subsequent login (no duplicate)');

    const updates = prisma.calls.userUpdate;
    assert(updates.length === 1, 'S2c: exactly one user.update on re-login (profile refresh)');
    assert(updates[0]?.data?.login === 'octocat-renamed',
      'S2d: mutable login field refreshed');
    assert(updates[0]?.data?.avatarUrl === 'https://new-avatar',
      'S2e: mutable avatarUrl field refreshed');

    // IdentityLink upsert should still happen (to refresh the token secret) but
    // should target the SAME (provider, providerAccountId) key, not insert a new row.
    assert(prisma.calls.identityLinkUpsert.length === 1,
      'S2f: IdentityLink upsert called once (refreshes token secret)');
    assert(prisma.calls.identityLinkUpsert[0]?.where?.provider_providerAccountId?.providerAccountId === '12345',
      'S2g: upsert still keys on the same numeric github id (no new identity row)');
  }

  // S3: Gate is first — non-allowlisted identity triggers NO User creation, NO
  //     IdentityLink creation. Record persistence NEVER substitutes for the gate.
  {
    const prisma = makePrisma({ existingIdentityLink: null });
    const svc = new AuthSessionService(prisma, stubAudit);
    const githubUser = makeGithubUser(99999);

    const result = await svc.establishSessionForGitHubUser(
      githubUser,
      'gh-access-token-denied',
      { AUTH_ALLOWLIST: '12345' },  // 99999 is NOT allowlisted
    );

    assert(result === null,
      'S3a: non-allowlisted github identity is denied (null result)');
    assert(prisma.calls.userCreate.length === 0,
      'S3b: no User row created for a non-allowlisted identity (gate is first)');
    assert(prisma.calls.identityLinkUpsert.length === 0,
      'S3c: no IdentityLink row created for a non-allowlisted identity (gate is first)');
    assert(prisma.calls.sessionCreate === 0,
      'S3d: no session minted for a non-allowlisted identity');
  }

  // ── summary ─────────────────────────────────────────────────────────────────
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
