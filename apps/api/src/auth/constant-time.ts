import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time operator-token comparison helper (auth 11.3).
 *
 * Compares a presented token against the configured operator token (`AUTH_TOKEN`)
 * WITHOUT short-circuiting on the first differing byte. A naive `a === b` (or
 * `Buffer.equals` on the raw bytes) leaks length and prefix information through
 * its timing: an attacker can recover a secret byte-by-byte by measuring how long
 * the comparison runs. The operator token is the single credential gating the
 * whole control plane (effectively remote code execution into a credentialed
 * sandbox), so this comparison must be timing-safe.
 *
 * Implementation notes:
 * - We hash BOTH inputs to a fixed-width SHA-256 digest before calling
 *   {@link timingSafeEqual}. `crypto.timingSafeEqual` throws when the two buffers
 *   differ in length, which would itself reveal whether the presented token is
 *   the right length. Comparing equal-length digests instead keeps the work (and
 *   thus the timing) independent of the inputs' lengths, while a digest mismatch
 *   still maps one-to-one to a token mismatch for any practical purpose.
 * - This helper makes no decisions about what a "valid" token is beyond exact
 *   equality; emptiness / configuration checks (e.g. refuse-to-boot on an unset
 *   `AUTH_TOKEN`) are the bootstrap layer's responsibility (Track 14) and are not
 *   performed here.
 */

/** Fixed-width digest of a UTF-8 string, used as the constant-time comparison input. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Returns `true` when `presented` exactly equals `configured`, comparing in
 * constant time relative to the inputs.
 *
 * Both arguments are required strings. Callers that may hold `undefined` (e.g. a
 * missing header, or an unread config value) MUST guard for presence before
 * calling this; an absent token is a rejection, not a comparison.
 */
export function constantTimeEqual(presented: string, configured: string): boolean {
  // Hashing to a constant 32-byte width makes timingSafeEqual's length precondition
  // hold for any inputs and removes length-dependent timing from the comparison.
  return timingSafeEqual(digest(presented), digest(configured));
}
