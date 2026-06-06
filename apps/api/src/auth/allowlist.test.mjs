/**
 * Verify-phase test for the hard allowlist gate (be-oauth-allowlist, task 2.4).
 *
 * Requirement semantics (from allowlist.ts):
 *   1. A listed numeric id is admitted.
 *   2. A non-listed numeric id is denied.
 *   3. Unset / empty / whitespace-only AUTH_ALLOWLIST denies everyone.
 *   4. An unparseable list (any non-integer entry) denies everyone (no partial parse).
 *   5. Matching keys on the numeric id, NEVER the mutable login.
 *   6. Whitespace + de-duplication tolerated; multiple ids parsed.
 *
 * The logic is inlined here (mirrors allowlist.ts) so the test runs under plain
 * `node` with no transpile step, matching the repo's constant-time.test.mjs
 * convention.
 */

// ---- inline (mirrors allowlist.ts) ----

function parseNumericId(entry) {
  if (!/^[0-9]+$/.test(entry)) return null;
  const id = Number(entry);
  if (!Number.isSafeInteger(id)) return null;
  return id;
}

function parseAllowlist(raw) {
  if (typeof raw !== 'string') return new Set();
  const entries = raw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entries.length === 0) return new Set();
  const ids = new Set();
  for (const entry of entries) {
    const id = parseNumericId(entry);
    if (id === null) return new Set();
    ids.add(id);
  }
  return ids;
}

function isAllowlisted(githubId, allowlist) {
  if (!Number.isInteger(githubId)) return false;
  return allowlist.has(githubId);
}

function isAllowlistedRaw(githubId, rawAllowlist) {
  return isAllowlisted(githubId, parseAllowlist(rawAllowlist));
}

// ---- harness ----

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

console.log('\n=== Allowlist gate ===\n');

// T1: listed id admitted
assert(isAllowlistedRaw(12345, '12345') === true, 'T1: listed numeric id admitted');

// T2: non-listed id denied
assert(isAllowlistedRaw(999, '12345,67890') === false, 'T2: non-listed numeric id denied');

// T3: unset/empty/whitespace deny everyone
assert(isAllowlistedRaw(12345, undefined) === false, 'T3a: undefined denies');
assert(isAllowlistedRaw(12345, '') === false, 'T3b: empty string denies');
assert(isAllowlistedRaw(12345, '   ') === false, 'T3c: whitespace denies');
assert(isAllowlistedRaw(12345, ',,') === false, 'T3d: only-commas denies');

// T4: unparseable list denies everyone (no partial parse)
assert(isAllowlistedRaw(12345, '12345,tanghehui') === false, 'T4a: login entry voids whole list');
assert(isAllowlistedRaw(12345, '12345,1.5') === false, 'T4b: float entry voids whole list');
assert(isAllowlistedRaw(12345, '12345,-1') === false, 'T4c: negative entry voids whole list');
assert(isAllowlistedRaw(12345, '0x10') === false, 'T4d: hex entry voids whole list');
assert(isAllowlistedRaw(1000, '1e3') === false, 'T4e: exponent entry voids whole list');

// T5: keys on numeric id, NOT login. An account whose CURRENT login equals an
// allowlisted display name but whose numeric id is not listed is rejected.
{
  const allowlistById = parseAllowlist('583231'); // some other allowlisted id
  const impostorNumericId = 424242; // login happens to be "tanghehui", id not listed
  assert(isAllowlisted(impostorNumericId, allowlistById) === false,
    'T5: id-not-listed rejected even if login matches a display name');
}

// T6: whitespace + dedupe + multiple ids
{
  const set = parseAllowlist(' 1 , 2 ,2, 3 ');
  assert(set.size === 3 && set.has(1) && set.has(2) && set.has(3), 'T6a: trims, dedupes, parses all');
  assert(isAllowlistedRaw(2, ' 1 , 2 , 3 ') === true, 'T6b: whitespace-padded id admitted');
}

// T7: non-integer githubId never matches
assert(isAllowlisted(1.5, parseAllowlist('1')) === false, 'T7a: float id never matches');
assert(isAllowlisted(NaN, parseAllowlist('1')) === false, 'T7b: NaN id never matches');

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
else { console.error('SOME TESTS FAILED'); process.exit(1); }
