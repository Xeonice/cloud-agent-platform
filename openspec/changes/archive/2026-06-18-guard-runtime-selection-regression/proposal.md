## Why

`claude-code` shipped selectable in v0.6.0 but was 100% non-functional — every task, including `runtime=claude-code`, was silently provisioned through codex because the provision-time read path (`getTaskRuntime`) was missing, and nothing failed loudly (see `research-brief.md`). The fix (#19, released v0.7.0) restored selection, but the three gaps that let a fully-broken feature pass CI and ship are still open: the registry depends on `getTaskRuntime` through an OPTIONAL cast (not a typed port member), no fast/CI test exercises the real selection seam, and the remaining fallback degrades to codex silently. Without closing them, a future refactor can silently re-break selection again — it already had to be fixed twice.

## What Changes

- **Compile-enforce the selection dependency.** `IntegrationRuntimeRegistry` SHALL depend on `ProvisionLookup.getTaskRuntime` as a REQUIRED port member, dropping the widening `lookup as (ProvisionLookup & { getTaskRuntime?: ... })` cast + the `typeof reader?.getTaskRuntime !== 'function'` escape hatch. Removing `getTaskRuntime` from any `ProvisionLookup` implementation then becomes a strict-typecheck CI failure (gate #17), not a silent runtime fallback.
- **Add a real-seam regression test (CI-fast).** A test exercises the REAL `IntegrationRuntimeRegistry` against a real-shaped `ProvisionLookup` (and the real `PrismaProvisionLookup` against a fake Prisma client) and asserts: a `claude-code` task resolves `ClaudeCodeRuntime`; a `codex`/absent-runtime task resolves `CodexRuntime`. This pins the exact create→persist→read→dispatch seam the DOA bug broke, in the fast unit suite (NOT the self-skipping amd64 e2e).
- **Make the remaining legitimate fallback loud.** When `readTaskRuntime` cannot resolve a runtime — lookup genuinely unwired (`@Optional()` absent), a lookup error, or an out-of-set stored value — it SHALL log at `warn` (today it warns only on a thrown error), so a degradation to the codex default is never silent.

Out of scope: the runtime-selection MECHANISM (correct since #19); the amd64 compose e2e (stays the integration backstop); any runtime behavior, contract, DB, or image change.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `agent-runtime`: add a requirement that a task's persisted `runtime` deterministically selects the provisioning runtime through a REQUIRED (compile-enforced) port method, is regression-tested at the real lookup→registry→runtime seam in the fast suite, and NEVER silently falls back to the default — a resolution failure is logged, never swallowed.

## Impact

- **Code** (`apps/api`):
  - `agent-runtime/agent-runtime.integration.ts` — `readTaskRuntime` calls the required `lookup.getTaskRuntime` directly (cast + `typeof` guard removed); warn on unresolved/out-of-set/error before defaulting.
  - `sandbox/provision-lookup.port.ts` — confirm `getTaskRuntime` is a required member (already added in #19); the registry now relies on that typing.
  - New/extended tests: a real-seam selection test (e.g. `agent-runtime/runtime-selection.test.mjs`) + a `prisma-provision-lookup` `getTaskRuntime` unit test.
- **CI**: the strict typecheck gate (#17) now structurally catches a missing `getTaskRuntime`; the new test runs in the existing `turbo test`/unit lane.
- **No** contract, DB schema, image, or frontend change. **No** behavior change for a correctly-wired deployment — this is a regression guard.
