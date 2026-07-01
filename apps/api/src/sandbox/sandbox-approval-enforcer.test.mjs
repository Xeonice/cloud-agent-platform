/**
 * Focused unit test for the cap-controlled approval enforcement FALLBACK
 * (harden-aio-execution, integration task 6.9; design D8 ★, codex#16732).
 *
 * Spec scenario under test (agent-events-and-approvals, "Fallback enforces
 * approval when codex hooks are unreliable"):
 *   - WHEN live verification shows the codex PreToolUse hook does not reliably
 *     fire for a tool call that requires approval
 *   - THEN approval is enforced at a cap-controlled layer rather than relying on
 *     codex firing the hook
 *   - AND the system does not allow the gated tool call to proceed without an
 *     approval decision
 *
 * This drives the REAL SandboxApprovalEnforcer against a stub ApprovalRouter:
 *   1. allow   -> the gated action RUNS and the result is returned.
 *   2. deny    -> the gated action is NEVER run; enforceThen throws.
 *   3. timeout -> no decision -> fail CLOSED; the action is NEVER run.
 *   4. router error -> fail CLOSED; the action is NEVER run.
 *
 * Mirrors the repo's `.test.mjs` convention (compile the real `.ts` with tsc,
 * import it, drive with a stub; plain node, inline assertions).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const enforcerSrc = join(__dirname, 'sandbox-approval-enforcer.ts');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

// ---- compile the REAL enforcer to a temp module -----------------------------
const outDir = mkdtempSync(join(apiRoot, '.aio-enforcer-test-'));

function compile() {
  execFileSync(
    tscBin,
    [
      enforcerSrc,
      '--outDir', outDir,
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'ES2021',
      '--experimentalDecorators',
      '--emitDecoratorMetadata',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const flat = join(outDir, 'sandbox-approval-enforcer.js');
  if (existsSync(flat)) return flat;
  const hit = findFile(outDir, 'sandbox-approval-enforcer.js');
  if (hit) return hit;
  throw new Error('compiled sandbox-approval-enforcer.js not found under ' + outDir);
}
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
}

const TASK_ID = '11111111-1111-1111-1111-111111111111';

/** A stub router that resolves with a fixed decision, recording the frame. */
function decisionRouter(decision) {
  const seen = [];
  return {
    seen,
    async requestApproval(frame) {
      seen.push(frame);
      return { decision };
    },
  };
}

async function main() {
  const enforcerJs = compile();
  const { SandboxApprovalEnforcer, ApprovalDeniedError } = await import(pathToFileURL(enforcerJs).href);

  // --- 1) allow -> action RUNS, result returned -----------------------------
  {
    const router = decisionRouter({ behavior: 'allow', message: 'ok by operator' });
    const enforcer = new SandboxApprovalEnforcer(router);
    let ran = false;
    const result = await enforcer.enforceThen(
      { taskId: TASK_ID, toolName: 'shell', toolInput: { command: 'echo hi' } },
      async () => { ran = true; return 'RESULT'; },
    );
    assert(ran === true, 'allow: the gated action runs');
    assert(result === 'RESULT', 'allow: enforceThen returns the action result');
    // The routed frame is a real permission_request carrying the tool identity.
    const f = router.seen[0];
    assert(f && f.type === 'permission_request' && f.toolName === 'shell' && f.taskId === TASK_ID,
      'allow: a permission_request frame is routed through the existing approval path');
  }

  // --- 2) deny -> action NEVER runs; enforceThen throws ----------------------
  {
    const router = decisionRouter({ behavior: 'deny', message: 'nope' });
    const enforcer = new SandboxApprovalEnforcer(router);
    let ran = false;
    let threw = null;
    try {
      await enforcer.enforceThen(
        { taskId: TASK_ID, toolName: 'shell', toolInput: { command: 'rm -rf /' } },
        async () => { ran = true; return 'SHOULD_NOT_RUN'; },
      );
    } catch (e) { threw = e; }
    assert(ran === false, 'deny: the gated action is NEVER run (does not proceed without an allow)');
    assert(threw instanceof ApprovalDeniedError, 'deny: enforceThen throws ApprovalDeniedError');
    const outcome = await enforcer.enforce({ taskId: TASK_ID, toolName: 'shell', toolInput: {} });
    assert(outcome.allowed === false, 'deny: enforce() reports allowed=false');
  }

  // --- 3) timeout -> no decision -> fail CLOSED; action NEVER runs -----------
  {
    const hangingRouter = { async requestApproval() { return new Promise(() => {}); } };
    const enforcer = new SandboxApprovalEnforcer(hangingRouter, 60); // 60ms timeout
    let ran = false;
    const outcome = await enforcer.enforce({ taskId: TASK_ID, toolName: 'shell', toolInput: {} });
    assert(outcome.allowed === false, 'timeout: a never-answered request fails CLOSED (allowed=false)');
    let threw = false;
    try {
      await enforcer.enforceThen(
        { taskId: TASK_ID, toolName: 'shell', toolInput: {} },
        async () => { ran = true; return 'x'; },
      );
    } catch { threw = true; }
    assert(ran === false && threw, 'timeout: the gated action is NEVER run on no decision');
  }

  // --- 4) router error -> fail CLOSED; action NEVER runs ---------------------
  {
    const errorRouter = { async requestApproval() { throw new Error('approval path down'); } };
    const enforcer = new SandboxApprovalEnforcer(errorRouter);
    const outcome = await enforcer.enforce({ taskId: TASK_ID, toolName: 'apply_patch', toolInput: {} });
    assert(outcome.allowed === false, 'router error: fails CLOSED (allowed=false)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((err) => { console.error(err); failed++; })
  .finally(() => {
    rmSync(outDir, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
  });
