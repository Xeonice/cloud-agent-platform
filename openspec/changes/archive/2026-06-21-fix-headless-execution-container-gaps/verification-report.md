# Verification Report — fix-headless-execution-container-gaps

## Three-way routing (this pass)

| Requirement | Verdict | Destination |
| --- | --- | --- |
| Headless-exec resolves a task to terminal on process exit | **UNMET (pass 1)** → **MET (pass 2)** | 5.1 fixed; re-traced MET, folded below |
| Execution mode is a declarative, consumer-selected runtime capability | MET | folded below |
| Code-to-task / scope mapping (no out-of-spec behaviour) | MET | folded below |

## Pass 2 re-adjudication — R2 now MET (verify-reopened 5.1 landed)

The prior pass routed "Headless-exec resolves a task to terminal on process exit" to UNMET because
`resolveViaExitFile` read the live `/v1/shell/exec` response off the TOP level while the live AIO
server nests the result under `data`. That defect (task 5.1) has been FIXED, and the requirement
now re-traces end-to-end as **MET**:

- **Data-nested unwrap landed.** `resolveViaExitFile` (`aio-pty-client.ts:1007-1020`) no longer
  reads `body.stdout`/`body.output` at the top level — it delegates to the new exported pure
  function `exitCodeFromExecBody` (`aio-pty-client.ts:1138-1149`), which reads `output`/`stdout`
  from `top.data ?? top` (line 1141), mirroring `runSandboxExec`/`parseExecResult`. On the live
  `{data:{output:"0\n"}}` shape this now yields `coerceExitCode('0')` = `0` rather than `null`.
- **Sentinel-first branch intact.** `resolveExitStatus` (`aio-pty-client.ts:972-977`) still calls
  `resolveViaExitFile()` FIRST for `headless-exec` and returns `{code, abnormal:false}` on a parsed
  code; only on a miss does it fall through to wait/echo.
- **Sentinel write sound + quote-safe.** `wrapHeadlessDetachedSession` (`codex-launch.ts:153-159`)
  appends `; echo $? > <headlessExitFile>` inside the single-quoted inner (no new quote → invariant
  holds). Both runtimes' `buildHeadlessLine`/`buildResumeLine` use it; interactive `buildLaunchLine`
  keeps `wrapInDetachedSession` (codex-runtime.ts:243,256; claude-code-runtime.ts:287,295,128).
- **Three scenarios map correctly downstream.** `recordExit` (`guardrails.service.ts:508-548`):
  `code===0 && !abnormal` → `recordSuccess` + transition `completed` (succeeded); non-zero →
  `recordFailure` + transition `failed`; `abnormal` → `recordExitDetail` + `forceFail`. A clean
  `0` from the sentinel is now classified `succeeded`, NOT abnormal-failed — covering Scenario 1
  (zero→succeeded, no operator input), Scenario 2 (non-zero→failed via sentinel), and Scenario 3
  (clean exit not mis-read as abnormal).
- **Regression test added.** `headless-execution.spec.ts` mocks the `data`-nested exec body for
  `exitCodeFromExecBody`, closing the gap that let the original defect slip past task 4.1.

No new code task is warranted for R2 this pass; the verify-reopened track (5.1) already carried the
fix and is `[x]`. Live MCP smoke (task 4.2) remains the only outstanding empirical gate, unchanged.

## MET (re-traced, satisfied)

### R1 — "Execution mode is a declarative, consumer-selected runtime capability"

Re-traced end-to-end and confirmed satisfied (the skeptic's own `gap` review reached the same
conclusion and is folded here):

- `executionModes` declared on the port (`agent-runtime.port.ts`), `buildHeadlessLine` on both
  runtimes (`codex-runtime.ts:237`, `claude-code-runtime.ts:277`).
- Consumer selection — console → `interactive-pty`, MCP/`/v1` → `headless-exec`
  (`mcp.server.ts`, `v1-tasks.controller.ts`).
- Persisted on the task (`executionMode` column, `schema.prisma`, `tasks.service.ts`) and read
  back by provisioning + by the pty client's `resolveExecutionMode`
  (`aio-pty-client.ts:296-398`).
- A runtime without `headless-exec` rejects programmatic creation (`tasks.service.ts:503-513`).
- The headless launch selection (`select-launch.ts:42-55`) forces
  `terminalStartup = {replyToStartupDSR:false, promptSubmit:'none'}` and `armAutoSubmit=false` —
  inert DSR/CR handshake for headless, byte-identical interactive path.

All declaration + routing + persistence + read-back links trace cleanly.

### Code-to-task / scope (skeptic `scope` review)

Every changed line maps to a task (1.1, 1.2, 2.1-2.4, 3.1, 3.2); no out-of-spec behaviour was
introduced. Folded as MET — with the caveat below: clean task-to-line mapping does NOT by itself
prove the live runtime behaviour, which is where R2 fails.

## UNMET (re-opened as code task 5.1)

### R2 — "Headless-exec resolves a task to terminal on process exit"

The skeptic flagged this as a high-risk requirement but, after listing the wiring, leaned toward
MET. Re-tracing against the actual exec-response shape shows it is **UNMET** — the sentinel is
written correctly but cannot be READ on the live server, so the very defect D2 set out to fix
(a clean headless success reported as `failed`) still fires.

Correct + verified parts:
- `wrapHeadlessDetachedSession` (`codex-launch.ts:153-159`) appends
  `; echo $? > /home/gem/.cap-headless-<id>.exit` inside the single-quoted inner — sentinel write
  is sound and quote-safe.
- Both runtimes' `buildHeadlessLine`/`buildResumeLine` use the headless wrapper; interactive keeps
  `wrapInDetachedSession`.
- `resolveExitStatus` (`aio-pty-client.ts:972-977`) calls `resolveViaExitFile()` FIRST for
  `headless-exec`; the executionMode branch IS reached (`ensureRuntimeResolved`,
  `aio-pty-client.ts:385-397`).
- Downstream mapping `0 → recordSuccess`, non-zero → `recordFailure` is unchanged and correct.

The defect — `resolveViaExitFile` reads the live response off the TOP level:
- `resolveViaExitFile` (`aio-pty-client.ts:1007-1026`) reads `body.stdout` / `body.output` at the
  top level.
- The live AIO `/v1/shell/exec` NESTS the result under `data`
  (`{success, message, data:{exit_code, output, stdout, ...}}`). Proven twice in-repo:
  `AioSandboxProvider.parseExecResult` docstring (`aio-sandbox.provider.ts:1176-1196`: reading
  the fields off the TOP level "yields `undefined` ... even on a successful command (the bug that
  blocked auth-inject/clone)") and `runSandboxExec` in the SAME pty client
  (`aio-pty-client.ts:927-931`), which already unwraps `top.data ?? top`.
- Live consequence: `cat <sentinel>` → `{data:{output:"0\n"}}` → top-level `stdout`/`output`
  `undefined` → `out=''` → `coerceExitCode('')`=null → fall through to `resolveViaWait` →
  `resolveViaEcho` (both miss the detached headless session's exit) → `{code:null, abnormal:true}`
  → `recordFailure` → `failed`. The clean `succeeded` is still reported as `failed`.

Why the unit suite (task 4.1) is green anyway: no spec mocks a `data`-nested exec response for the
exit-file read; the headless specs only pin launch-line/argv shape. The one check that would expose
this is the live MCP smoke (task 4.2), which is still unchecked.

Fix tracked in tasks.md → `## Track: verify-reopened` task 5.1.
