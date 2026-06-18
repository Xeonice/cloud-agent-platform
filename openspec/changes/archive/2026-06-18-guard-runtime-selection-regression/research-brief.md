# Research brief — guard-runtime-selection-regression

Grounding for this change. Evidence collected in two adversarial code-verification
passes over `main @ e611ab9` (workflows `verify-arch-review-claims`,
`rereview-main-agent-runtime-refactor`) plus direct reads. Summarized in
`docs/backend-architecture-review.md` §4.2 / §5 (P0).

## The defect this change prevents (history)

`claude-code` shipped as a selectable runtime in **v0.6.0** (#18) but was **100%
non-functional** — every task, including `runtime=claude-code`, was silently
provisioned through **codex**:

- The `ProvisionLookup` port never declared `getTaskRuntime` in #18.
- `IntegrationRuntimeRegistry.readTaskRuntime` guards with
  `if (typeof reader?.getTaskRuntime !== 'function') return null`
  (`apps/api/src/agent-runtime/agent-runtime.integration.ts:163-167`), reading the
  method off a widening cast `lookup as (ProvisionLookup & { getTaskRuntime?: ... })`.
- The guard always tripped → `readTaskRuntime` always returned `null` →
  `registry.resolve(null)` returned `CodexRuntime`
  (`agent-runtime.registry.ts:49-50`).
- The create path persisted `task.runtime='claude-code'` correctly and the read
  path echoed it correctly, so there was **no visible signal** — a user selecting
  claude-code watched codex run in the terminal.

Fixed in #19 (`getTaskRuntime` added to the port + prisma impl,
`provision-lookup.port.ts:69`, `prisma-provision-lookup.ts:74-80`); released as
**v0.7.0** via #20 (empty `Release-As` commit). The bug was fixed twice (#19 title
"fix claude-code selection" + #20 re-surfacing it).

## Why it shipped, and why it can re-break

Three gaps let a 100%-broken feature pass CI and ship:

1. **Compile-time gap.** The registry depends on `getTaskRuntime` through an
   OPTIONAL widening cast, not the port's now-required member. So removing
   `getTaskRuntime` from `PrismaProvisionLookup` is **not** a type error — the
   strict typecheck CI gate (#17) cannot catch the exact class of regression.
2. **Test-time gap.** No fast/CI test exercises the real
   `IntegrationRuntimeRegistry` + the real `ProvisionLookup` contract. Existing
   tests all bypass the broken seam:
   - `agent-runtime.test.mjs:177` tests the LEAF `registry.resolve('claude-code')`.
   - `tasks.service.test.mjs:344` uses a FAKE registry and tests CREATE-time
     `resolve()`, not provision-time `resolveForTask()→getTaskRuntime()`.
   - No `prisma-provision-lookup` unit test exists.
   - The only real-path coverage is `aio-e2e.mjs`, which **self-skips without a
     token** and is self-hosted amd64-only (not in CI).
3. **Runtime gap.** When selection genuinely cannot resolve (lookup unwired / DB
   error / out-of-set value), `readTaskRuntime` returns `null` → codex, and
   `logger.warn` fires **only on a thrown error** (`integration.ts:171-176`) — a
   missing method or an out-of-set DB value degrades **silently**.

## Scope decision

A focused regression test (the original P0) closes gap #2 but leaves #1 and #3 — a
future refactor could still silently re-break selection. This change closes all
three (compile-enforce the port dependency, regression-test the seam, make the
remaining legitimate fallback loud), because they share one root cause: a
silent-by-construction selection path.

Out of scope: the selection MECHANISM itself (correct post-#19), the amd64 compose
e2e (stays the integration backstop), any runtime behavior, any contract/DB/image
change.

## Affected capability

`agent-runtime` — owns runtime resolution (the integration registry +
`ProvisionLookup` port consumption). No new capability; this strengthens existing
selection behavior with a regression-guard requirement.
