/**
 * Minimal test: "GitHub access token is stored on the github identity"
 * (add-private-account-identity requirement)
 *
 * The token must be written to the `secret` field of the user's `github`
 * IdentityLink (provider="github"), NOT to any column on the User table.
 * The shared helper must round-trip: set -> get returns the original token.
 *
 * Drives the REAL compiled dist — no mocking of the storage logic.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_AUTH = path.resolve(here, '../../dist/auth');

const { setGithubTokenForUser, getGithubTokenForUser, GITHUB_IDENTITY_PROVIDER } = require(
  path.join(DIST_AUTH, 'github-identity.js'),
);

// ── in-memory Prisma double ──────────────────────────────────────────────────

/**
 * Returns a minimal Prisma double with a real in-memory identityLink store.
 * Captures every upsert call so we can assert the write shape.
 */
function makePrisma() {
  const store = {}; // key: "provider:providerAccountId"
  const upsertCalls = [];

  return {
    upsertCalls,
    store,
    identityLink: {
      findFirst: async ({ where, select }) => {
        const key = `${where.provider}:${where.userId}`;
        // find by userId + provider
        const entry = Object.values(store).find(
          (r) => r.userId === where.userId && r.provider === where.provider,
        );
        if (!entry) return null;
        return select ? { secret: entry.secret } : entry;
      },
      upsert: async ({ where, create, update }) => {
        const key = `${where.provider_providerAccountId.provider}:${where.provider_providerAccountId.providerAccountId}`;
        upsertCalls.push({ where, create, update });
        if (store[key]) {
          store[key] = { ...store[key], ...update };
        } else {
          store[key] = { id: `link-${key}`, ...create };
        }
        return store[key];
      },
    },
  };
}

// ── harness ──────────────────────────────────────────────────────────────────

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

const run = async () => {
  console.log('\n=== Requirement: GitHub access token is stored on the github identity ===\n');

  const TOKEN = 'ghp_fakeTestToken_abc123xyz';
  const USER_ID = 'user-001';
  const GITHUB_ID = 42000;
  const env = {}; // no encryption key → plaintext storage (transparent test)

  // ── T1: token is written to the IdentityLink secret, not lost ─────────────
  {
    const prisma = makePrisma();

    await setGithubTokenForUser(
      prisma,
      { userId: USER_ID, githubId: GITHUB_ID, token: TOKEN },
      env,
    );

    assert(
      prisma.upsertCalls.length === 1,
      'T1a: setGithubTokenForUser issues exactly one identityLink.upsert',
    );

    const upsert = prisma.upsertCalls[0];

    // Provider discriminator
    assert(
      upsert?.where?.provider_providerAccountId?.provider === GITHUB_IDENTITY_PROVIDER,
      'T1b: upsert keyed with provider = "github" (GITHUB_IDENTITY_PROVIDER)',
    );

    // Keyed on numeric github id (as string)
    assert(
      upsert?.where?.provider_providerAccountId?.providerAccountId === String(GITHUB_ID),
      'T1c: upsert keyed on the numeric github id stringified (not the login)',
    );

    // Token stored as the `secret` field in the create payload
    assert(
      upsert?.create?.secret === TOKEN,
      'T1d: access token stored as `secret` in the IdentityLink create payload',
    );

    // Token stored as the `secret` field in the update payload
    assert(
      upsert?.update?.secret === TOKEN,
      'T1e: access token stored as `secret` in the IdentityLink update payload',
    );

    // Token NOT stored on the User table (no user.create / user.update called)
    assert(
      typeof prisma.user === 'undefined',
      'T1f: no user-table write is issued (token is identity-only, not a User column)',
    );
  }

  // ── T2: round-trip — getGithubTokenForUser returns the original token ─────
  {
    const prisma = makePrisma();

    await setGithubTokenForUser(
      prisma,
      { userId: USER_ID, githubId: GITHUB_ID, token: TOKEN },
      env,
    );

    const recovered = await getGithubTokenForUser(prisma, USER_ID, env);

    assert(
      recovered === TOKEN,
      'T2: getGithubTokenForUser returns the exact token stored by setGithubTokenForUser (round-trip)',
    );
  }

  // ── T3: no token stored → getGithubTokenForUser returns null ─────────────
  {
    const prisma = makePrisma();

    const result = await getGithubTokenForUser(prisma, 'no-such-user', env);

    assert(
      result === null,
      'T3: getGithubTokenForUser returns null when no github identity exists for the user',
    );
  }

  // ── T4: second login refreshes the secret on the SAME identity row ─────────
  {
    const prisma = makePrisma();
    const TOKEN2 = 'ghp_refreshedToken_xyz789';

    await setGithubTokenForUser(prisma, { userId: USER_ID, githubId: GITHUB_ID, token: TOKEN }, env);
    await setGithubTokenForUser(prisma, { userId: USER_ID, githubId: GITHUB_ID, token: TOKEN2 }, env);

    assert(
      prisma.upsertCalls.length === 2,
      'T4a: second login issues a second identityLink.upsert (refresh)',
    );
    assert(
      prisma.upsertCalls[1]?.where?.provider_providerAccountId?.providerAccountId === String(GITHUB_ID),
      'T4b: second upsert targets the SAME (provider, providerAccountId) key — no new identity row',
    );

    const recovered = await getGithubTokenForUser(prisma, USER_ID, env);
    assert(
      recovered === TOKEN2,
      'T4c: after refresh, getGithubTokenForUser returns the NEW token',
    );
  }

  // ── summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(68)}`);
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
