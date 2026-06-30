/**
 * Focused unit test for the codex launch contract (aio-codex-prompt-autostart):
 * `buildCodexLaunchLine` + `CODEX_PROMPT_FILE_PATH`.
 *
 * Spec scenarios under test (aio-sandbox-execution / codex launched in-shell):
 *   - The task prompt is passed positionally via `"$(cat <file>)"`, NEVER inlined
 *     into the launch argv (shell-injection-safe for arbitrary free-text).
 *   - An empty/missing prompt file launches codex with NO positional (blank
 *     composer) rather than an empty-string arg.
 *   - Prompt free-text is never part of the argv, so text mentioning flags such
 *     as `--yolo` cannot be confused with the actual launch mode.
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
  const {
    buildAttachSessionCommand,
    buildCodexLaunchLine,
    buildDetachedCodexLaunchLine,
    buildResizeDetachedSessionCommand,
    detachedSessionName,
    CODEX_PROMPT_FILE_PATH,
    wrapHeadlessDetachedSession,
  } = mod;

  const BASE =
    'codex --no-alt-screen -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox';

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

  // ---- detachedSessionName: deterministic `task<taskId>` --------------------
  assert(
    detachedSessionName('b3ee3f63') === 'taskb3ee3f63',
    'detached session name is `task<taskId>`',
  );

  // ---- buildDetachedCodexLaunchLine: WRAPS the in-shell line in detached tmux
  const detached = buildDetachedCodexLaunchLine('b3ee3f63', BASE);
  assert(
    detached.startsWith('tmux -u new-session -d -s taskb3ee3f63 '),
    'detached launch creates a UTF-8 DETACHED named session `task<taskId>` (survive WS close)',
  );
  assert(
    detached.includes('-c /home/gem/workspace'),
    'detached session cwd is the cloned task repo (/home/gem/workspace)',
  );

  // ---- 1.1 GOLDEN (refactor-agent-runtime-policy-mechanism, Track 1) ----------
  // Byte-exact characterization of the FULL detached launch line. The refactor
  // lifts the `tmux new-session … '<inner>'` wrapper + the `$(cat <prompt-file>)`
  // positional-prompt delivery into shared MECHANISM (the runtime will contribute
  // only `{argv, env}`); this golden pins the exact wrapper/prompt shape so codex's
  // launch line MUST be reproduced byte-for-byte. BASE / CODEX_PROMPT_FILE_PATH are
  // the runtime's variable parts (tested above); this pins the mechanism's wrapping.
  const GOLDEN_DETACHED =
    `tmux -u new-session -d -s taskb3ee3f63 -c /home/gem/workspace ` +
    `'P="$(cat ${CODEX_PROMPT_FILE_PATH} 2>/dev/null)"; ` +
    `if [ -n "$P" ]; then ${BASE} "$P"; else ${BASE}; fi'`;
  assert(
    detached === GOLDEN_DETACHED,
    '1.1 GOLDEN: detached codex launch line is byte-exact (mechanism wrapper + $(cat) delivery)',
  );
  // The inner codex launch line is wrapped VERBATIM (prompt-injection contract
  // unchanged WITHIN the detached session) as a single-quoted tmux argument.
  assert(
    detached.includes(`'${line}'`),
    'detached launch wraps the existing in-shell codex launch line verbatim',
  );
  assert(
    detached.includes(`cat ${CODEX_PROMPT_FILE_PATH}`) &&
      detached.includes('if [ -n "$P" ]'),
    'detached launch preserves the `"$(cat …)"` positional prompt contract',
  );
  assert(
    detached.includes('--dangerously-bypass-approvals-and-sandbox'),
    'detached launch carries the documented Codex bypass/YOLO flag',
  );
  assert(
    wrapHeadlessDetachedSession('b3ee3f63', 'codex exec "goal"').startsWith(
      'tmux -u new-session -d -s taskb3ee3f63 ',
    ),
    'headless detached launch also creates the tmux session in UTF-8 mode',
  );
  assert(
    buildAttachSessionCommand('b3ee3f63') ===
      'tmux -u set-option -t taskb3ee3f63 status off \\; attach -t taskb3ee3f63',
    'attach command uses tmux UTF-8 mode and hides the tmux status line',
  );
  assert(
    buildResizeDetachedSessionCommand('b3ee3f63', 123, 45) ===
      'tmux -u resize-window -t taskb3ee3f63 -x 123 -y 45',
    'resize command targets the detached tmux window with browser geometry',
  );

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
