/**
 * No-docker test for the local-dev env generator (local-one-click-dev, task 4.1).
 * Drives `scripts/gen-local-env.sh` against a TEMP dir using the REAL
 * `apps/api/.env.example` as input, so it also catches drift between the
 * generator and the example's declared keys. NO `docker build` is invoked, so it
 * stays CI-fast.
 *
 * Asserts:
 *   - every key the example declares appears in the generated env (copy-then-fill);
 *   - the three generated secrets are non-empty, hex-shaped, and DISTINCT;
 *   - the legacy operator-token path is enabled and WEB_ORIGIN is set for local dev;
 *   - the generator REFUSES to overwrite a pre-existing env (idempotent reuse).
 *
 * Mirrors the repo's `.test.mjs` convention (plain node, inline assertions).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const GEN = resolve(repoRoot, 'scripts/gen-local-env.sh');
const REAL_EXAMPLE = resolve(repoRoot, 'apps/api/.env.example');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

/** Parse `KEY=VALUE` lines into a map (ignores comments/blanks). */
function parseEnv(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) map[m[1]] = m[2];
  }
  return map;
}
/** Keys an .env-example file DECLARES (so the generator must preserve them all). */
function declaredKeys(text) {
  return Object.keys(parseEnv(text));
}

// ── case 1: fresh generation from the real example ──────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'genenv-'));
  const example = join(dir, '.env.example');
  const out = join(dir, '.env');
  copyFileSync(REAL_EXAMPLE, example);

  execFileSync('bash', [GEN, example, out], { stdio: 'pipe' });
  assert(existsSync(out), 'case1: generator wrote the out file');

  const exampleText = readFileSync(example, 'utf8');
  const outText = readFileSync(out, 'utf8');
  const exKeys = declaredKeys(exampleText);
  const gen = parseEnv(outText);

  const missing = exKeys.filter((k) => !(k in gen));
  assert(missing.length === 0, `case1: every example key flows through (missing: ${missing.join(',') || 'none'})`);

  assert(gen.AUTH_TOKEN_LEGACY_ENABLED === 'true', 'case1: legacy operator-token path enabled');
  assert(gen.WEB_ORIGIN === 'http://localhost:3000', 'case1: WEB_ORIGIN set for local dev');

  const secrets = [gen.AUTH_TOKEN, gen.SESSION_SECRET, gen.CODEX_CRED_ENC_KEY];
  assert(secrets.every((s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)), 'case1: three 32-byte hex secrets generated');
  assert(new Set(secrets).size === 3, 'case1: the three secrets are distinct');
}

// ── case 2: refuses to overwrite an existing env (idempotent reuse) ──────────
{
  const dir = mkdtempSync(join(tmpdir(), 'genenv-'));
  const example = join(dir, '.env.example');
  const out = join(dir, '.env');
  copyFileSync(REAL_EXAMPLE, example);
  const sentinel = 'AUTH_TOKEN=DO-NOT-CLOBBER\nSESSION_SECRET=keep-me\n';
  writeFileSync(out, sentinel);

  const code = (() => {
    try { execFileSync('bash', [GEN, example, out], { stdio: 'pipe' }); return 0; }
    catch (e) { return e.status ?? 1; }
  })();
  assert(code === 0, 'case2: generator exits 0 (idempotent) when env already exists');
  assert(readFileSync(out, 'utf8') === sentinel, 'case2: existing env is left UNCHANGED (not overwritten)');
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
else { console.error('SOME TESTS FAILED'); process.exit(1); }
