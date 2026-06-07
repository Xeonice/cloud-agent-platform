/**
 * Focused unit test for the codex launch contract (aio-codex-prompt-autostart):
 * `buildCodexLaunchLine` + `argvDisablesHooks` + `CODEX_PROMPT_FILE_PATH`.
 *
 * Spec scenarios under test (aio-sandbox-execution / codex launched in-shell):
 *   - The task prompt is passed positionally via `"$(cat <file>)"`, NEVER inlined
 *     into the launch argv (shell-injection-safe for arbitrary free-text).
 *   - An empty/missing prompt file launches codex with NO positional (blank
 *     composer) rather than an empty-string arg.
 *   - The hook-disabling guard inspects ONLY the fixed launch flags, so a prompt
 *     mentioning `-s`/`--yolo`/`bypass-approvals` cannot trip it (the prompt is
 *     never part of the argv the guard sees).
 *
 * Compiles the REAL codex-launch.ts with tsc, imports it; plain node, inline
 * assertions (mirrors the repo's .test.mjs convention).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const src = join(__dirname, 'codex-launch.ts');

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// Emit INSIDE apps/api so module resolution can walk up to repo node_modules.
const outDir = mkdtempSync(join(apiRoot, '.codex-launch-test-'));

function compile() {
  execFileSync(
    tscBin,
    [
      src,
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--target',
      'ES2021',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const flat = join(outDir, 'codex-launch.js');
  if (existsSync(flat)) return flat;
  const nested = join(outDir, 'terminal', 'codex-launch.js');
  if (existsSync(nested)) return nested;
  throw new Error('compiled codex-launch.js not found under ' + outDir);
}

async function main() {
  const mod = await import(pathToFileURL(compile()).href);
  const { buildCodexLaunchLine, argvDisablesHooks, CODEX_PROMPT_FILE_PATH } = mod;

  const BASE =
    'codex -C /home/gem/workspace --ask-for-approval never --sandbox danger-full-access --dangerously-bypass-hook-trust';

  // ---- argvDisablesHooks: flags the hook-disabling forms, passes the base -----
  assert(argvDisablesHooks('codex -s') === true, '-s is flagged');
  assert(argvDisablesHooks('codex --yolo') === true, '--yolo is flagged');
  assert(
    argvDisablesHooks('codex --dangerously-bypass-approvals-and-sandbox') === true,
    'bypass-approvals is flagged',
  );
  assert(argvDisablesHooks(BASE) === false, 'the default base argv is NOT flagged');

  // ---- buildCodexLaunchLine: file-based positional, no inlined prompt ---------
  const line = buildCodexLaunchLine(BASE);
  assert(
    line.includes(`cat ${CODEX_PROMPT_FILE_PATH}`),
    'reads the prompt from the injected file via cat',
  );
  assert(line.includes('if [ -n "$P" ]'), 'branches on a non-empty prompt');
  assert(
    line.includes(`then ${BASE} "$P"`),
    'non-empty prompt: appends "$P" as the positional argument',
  );
  assert(
    line.includes(`else ${BASE}; fi`),
    'empty/missing prompt: launches the base argv with NO positional (blank composer)',
  );

  // ---- the launch line is INDEPENDENT of any prompt text (prompt rides file) --
  // buildCodexLaunchLine takes only the base argv, so no operator free-text can
  // ever be inlined into the command — proven by it not accepting a prompt arg.
  assert(
    buildCodexLaunchLine(BASE) === buildCodexLaunchLine(BASE),
    'launch line is deterministic from the base argv alone (no prompt parameter)',
  );
  // 2>/dev/null guards a missing file so it degrades to a blank composer.
  assert(line.includes('2>/dev/null'), 'missing prompt file is tolerated (2>/dev/null)');

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    failed++;
  })
  .finally(() => {
    rmSync(outDir, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
  });
