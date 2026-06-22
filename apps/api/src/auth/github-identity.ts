/**
 * Shared github-identity helper (add-private-account-identity, task 2.1).
 *
 * After the normalized-identity migration (local-account-identity spec), the
 * encrypted GitHub OAuth access token is no longer a column on `User` — it is the
 * `secret` of the user's `github` {@link IdentityLink}
 * (`provider="github"`, `providerAccountId=<numeric github id>`). This module is
 * the SINGLE place that reads/writes that secret, so every token consumer
 * (login write, repository import, sandbox clone provisioning, forge target
 * resolution) goes through one helper rather than touching the schema directly.
 *
 * The secret is stored/recovered through the same
 * {@link storeMaybeEncrypted}/{@link readMaybeEncrypted} envelope the previous
 * `User.githubAccessToken` column used (encrypted at rest when a server key is
 * configured, transparent plaintext in keyless dev/test) — the token never leaves
 * this boundary in cleartext except at the point of use.
 *
 * The Prisma surface is typed STRUCTURALLY (only the `identityLink` delegate
 * methods this helper calls) so the helper compiles against the generated client
 * once the `IdentityLink` model lands, without coupling callers to the full
 * `PrismaClient` type or to a NestJS provider.
 */

import {
  readMaybeEncrypted,
  storeMaybeEncrypted,
} from '../settings/secret-storage';

/** The fixed provider discriminator for a GitHub login identity. */
export const GITHUB_IDENTITY_PROVIDER = 'github' as const;

/**
 * A persisted {@link IdentityLink} row (the subset this helper reads/writes). The
 * `secret` carries the encrypted GitHub access-token envelope for a `github`
 * identity; it is nullable (a record predating token capture, or a refresh that
 * did not re-capture a token, leaves it null).
 */
interface IdentityLinkRow {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  secret: string | null;
}

/**
 * The minimal Prisma surface the helper needs: the `identityLink` delegate's
 * `findFirst` / `upsert`. Declared structurally so callers can pass a
 * `PrismaService` (which extends `PrismaClient`) or a transaction client without
 * this module importing the full generated client type.
 */
export interface IdentityLinkPrisma {
  identityLink: {
    findFirst(args: {
      where: { userId: string; provider: string };
      select?: { secret: true };
    }): Promise<{ secret: string | null } | null>;
    upsert(args: {
      where: { provider_providerAccountId: { provider: string; providerAccountId: string } };
      create: {
        userId: string;
        provider: string;
        providerAccountId: string;
        secret: string | null;
      };
      update: { userId: string; secret: string | null };
    }): Promise<IdentityLinkRow>;
  };
}

/**
 * Reads the operator's decrypted GitHub access token from their `github`
 * {@link IdentityLink} secret, or `null` when the user has no github identity,
 * the identity carries no secret, or the stored envelope fails to decrypt.
 *
 * This is the canonical read every token consumer uses in place of the removed
 * `User.githubAccessToken` column.
 */
export async function getGithubTokenForUser(
  prisma: IdentityLinkPrisma,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const link = await prisma.identityLink.findFirst({
    where: { userId, provider: GITHUB_IDENTITY_PROVIDER },
    select: { secret: true },
  });
  if (!link) {
    return null;
  }
  return readMaybeEncrypted(link.secret, env);
}

/**
 * Writes (creates or refreshes) the operator's `github` {@link IdentityLink}
 * carrying the encrypted access-token envelope as its `secret`. Keyed on the
 * immutable `(provider="github", providerAccountId=<numeric github id>)` unique
 * pair so a re-login refreshes the same identity in place and re-attaches it to
 * the resolved `userId`. The token is encrypted at rest via
 * {@link storeMaybeEncrypted} (transparent plaintext only in keyless dev/test).
 *
 * `providerAccountId` is the GitHub numeric id stringified — the identity key is a
 * string column even though the GitHub id is numeric.
 */
export async function setGithubTokenForUser(
  prisma: IdentityLinkPrisma,
  args: { userId: string; githubId: number; token: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const providerAccountId = String(args.githubId);
  const secret = storeMaybeEncrypted(args.token, env);
  await prisma.identityLink.upsert({
    where: {
      provider_providerAccountId: {
        provider: GITHUB_IDENTITY_PROVIDER,
        providerAccountId,
      },
    },
    create: {
      userId: args.userId,
      provider: GITHUB_IDENTITY_PROVIDER,
      providerAccountId,
      secret,
    },
    update: {
      userId: args.userId,
      secret,
    },
  });
}
