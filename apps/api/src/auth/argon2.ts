/**
 * Shared argon2 password hashing util (add-private-account-identity, task 2.2).
 *
 * The single place that hashes and verifies local-account passwords (and the
 * seeded admin password). Backed by `@node-rs/argon2` (native, prebuilt binaries)
 * configured for argon2id with sane parameters (D5). Both the password-auth login
 * service and the admin-seed bootstrap hash through {@link hashPassword} and
 * verify through {@link verifyPassword}, so the algorithm + parameters live in one
 * place and can never drift between the mint and check paths.
 *
 * `verifyPassword` is CONSTANT-TIME with respect to a correct-vs-incorrect
 * password: `@node-rs/argon2`'s `verify` re-derives the hash with the parameters
 * embedded in the stored PHC string and compares in constant time, so timing does
 * not leak whether the candidate was close. It also swallows a malformed/unknown
 * stored hash into a plain `false` (a corrupt row denies rather than throws), so a
 * verify never becomes an authentication-bypassing error path.
 */

import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * argon2id parameters (D5 "sane params"). These follow the OWASP-recommended
 * baseline for argon2id (memory ~19 MiB, 2 iterations, parallelism 1); they are
 * embedded into the produced PHC string, so {@link verifyPassword} re-derives with
 * the SAME cost a hash was minted under even if these defaults change later.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hashes a plaintext password into a self-describing argon2id PHC string (carrying
 * the salt + parameters), suitable for storing as a `password` identity's secret.
 * The result is non-deterministic (random salt) — never compare two hashes for
 * equality; always go through {@link verifyPassword}.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Constant-time verify of a candidate plaintext against a stored argon2id PHC
 * hash. Returns `true` only on a match; returns `false` (never throws) for a
 * mismatch OR for a malformed/unparseable stored hash, so a corrupt credential row
 * fails closed (denies) rather than surfacing an error the caller might mistake for
 * a different outcome.
 */
export async function verifyPassword(
  storedHash: string,
  candidate: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, candidate);
  } catch {
    return false;
  }
}
