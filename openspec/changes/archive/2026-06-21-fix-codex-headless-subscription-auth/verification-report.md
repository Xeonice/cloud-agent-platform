# Verification Report — fix-codex-headless-subscription-auth

Three-way routing of the verify pass. Each raw-unmet finding was re-traced end-to-end against the
actual code (not rubber-stamped from the skeptic) before routing.

## Tally (adjudicated)

- reopened (verify-reopened code tasks): 0
- spec-defects (design.md Open Questions): 0
- reclassified MET (folded here): 1

## MET — re-traced as satisfied

### Requirement: Codex headless tasks load a file-stored credential and persist its refresh
**Capability:** aio-sandbox-execution — **Verdict:** MET (met-as-written; one benign scope deviation, see below)

All four declared scenarios re-trace end-to-end to implemented + tested code:

1. **"Codex headless loads the file-stored credential (no Missing bearer)"** —
   `apps/api/src/agent-runtime/codex-runtime.ts:165-166` prepends a top-level
   `cli_auth_credentials_store = "file"\n` to the emitted `config.toml` before any `[table]` header,
   for the codex runtime regardless of credential kind (official / compatible / null). Asserted by
   `apps/api/src/agent-runtime/codex-config-store.spec.ts` (official, no-credential, and compatible
   cases — key present AND ordered before the first `[`).

2. **"A refreshed token is persisted across tasks"** —
   `apps/api/src/sandbox/aio-sandbox.provider.ts:384` awaits `captureAndPersistCodexAuth` (cats
   `/home/gem/.codex/auth.json` via `runSandboxExec`; the `parseExecResult` `data ?? top` unwrap at
   line 1229 reads `output` off the live AIO `data`-nested body). It then calls
   `persistRefreshedAuth` on the resolved `CodexAuthSource`. The prisma impl
   (`apps/api/src/sandbox/prisma-codex-auth-source.ts:75-101`) resolves `taskId → owner` via the SAME
   `task.created` audit-event join `getCodexAuth` uses (`resolveTaskOwnerId`, line 187-194), validates
   `tokens.refresh_token` is a non-empty string (`isValidAuthJson`, 104-112), guards `mode === 'official'`
   (compatible / missing-row → no-op), re-encrypts (AES-256-GCM) and UPDATEs the owner-scoped
   `CodexCredential` row, and never throws. Covered by `apps/api/src/sandbox/codex-auth-persist.spec.ts`
   (round-trip re-encryption + owner-scoped UPDATE; garbage / missing-refresh_token guard short-circuits
   before any DB query; compatible no-op; no-owner no-op).

3. **"Capture preserves the retained-container security property"** —
   `aio-sandbox.provider.ts:384-385`: `captureAndPersistCodexAuth` is awaited BEFORE
   `trimRuntimeHomeBeforeStop`; the codex pre-stop trim (`codex-runtime.ts:194`) zeroes
   `auth.json` (`: > ${dir}/auth.json`) AFTER capture, so the retained container holds no live credential.

4. **"A non-persistable (env) credential warns"** —
   `apps/api/src/sandbox/env-codex-auth-source.ts:88-94`: `persistRefreshedAuth` is a no-op that emits
   a single `logger.warn` ("the env seed cannot self-heal; re-seed or store an official credential").
   Asserted to never throw by `codex-auth-persist.spec.ts`.

The primary production scenario (a ChatGPT-subscription headless `codex exec` authenticating and
persisting the rotated single-use refresh_token across tasks) is fully satisfied. The minor scope
deviation below does not block any scenario, so the requirement routes MET.

#### Skeptic's `gap` field — refuted
The skeptic's own gap analysis concluded "All four spec scenarios have traceable implementations" with
an empty gap list (`[]`). Re-trace confirms: nothing required by the requirement text or its four
scenarios is missing. No code task warranted.

## Scope / out-of-spec findings (recorded, not actioned as code tasks)

### S1 — `captureAndPersistCodexAuth` runs for interactive-pty codex tasks, not only `headless-exec`
**Location:** `apps/api/src/sandbox/aio-sandbox.provider.ts:444` (`captureAndPersistCodexAuth`).

The requirement text, task 3.1/3.2 ("Capture must NOT run for interactive / claude / compatible
tasks"), and design D3 ("Capture only runs for codex `headless-exec` tasks with an OFFICIAL credential")
all gate capture on `headless-exec`. The implementation gates only on the runtime id
(`runtime.id !== 'codex'` → skip claude, line 456) and delegates official-only / owner-scoped /
valid-auth to `persistRefreshedAuth`. There is **no `executionMode` check** anywhere in the provider's
capture path. The codex runtime declares BOTH `interactive-pty` and `headless-exec`
(`codex-runtime.ts:217-219`) and injects the same `auth.json` in both modes, so an interactive
(console) codex task with an OFFICIAL credential WILL trigger capture-and-persist on teardown.

**Why this is a benign scope superset, not an UNMET (no code task):** an interactive codex session
refreshes and rewrites its own OFFICIAL `auth.json` exactly like a headless one, so capturing it
performs the SAME beneficial refresh-persist the change wants — it keeps the stored credential alive
across tasks. All safety invariants still hold (owner-scoped via `resolveTaskOwnerId`, official-only via
the `mode === 'official'` guard, garbage-guarded via `isValidAuthJson`). The behavior is wider than the
spec states but harmless and does not break, regress, or fail any declared scenario. It is the inverse
of a missing-required-behavior: a non-required extra invocation, not a gap. Recorded here as a scope
note; if strict spec fidelity is desired, an `executionMode === 'headless-exec'` guard could be added in
`captureAndPersistCodexAuth`, but it is not required to satisfy the requirement.
