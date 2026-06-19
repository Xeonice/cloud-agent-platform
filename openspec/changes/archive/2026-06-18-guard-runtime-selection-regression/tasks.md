<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within a
     track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: harden-registry (depends: none)

- [x] 1.1 In `apps/api/src/agent-runtime/agent-runtime.integration.ts` `readTaskRuntime`, remove the `this.lookup as (ProvisionLookup & { getTaskRuntime?: ... })` widening cast AND the `typeof reader?.getTaskRuntime !== 'function'` escape hatch; call `this.lookup.getTaskRuntime(taskId)` directly, relying on the now-required port member (`provision-lookup.port.ts:69`). Keep the `@Optional()`-injection `!this.lookup` (unwired) branch. (design D1)
- [x] 1.2 Make every fallback-to-codex condition LOUD: `warn` before returning `null` when (a) `this.lookup` is unwired, (b) `getTaskRuntime` throws (existing warn — keep), (c) the stored value is outside `{ 'codex', 'claude-code' }` (today returns null silently). Each message names the taskId and the reason. A `null` value (absent runtime — a codex task stores null) is the LEGITIMATE default and is NOT warned. (design D3)
- [x] 1.3 Run typecheck to confirm the direct `getTaskRuntime` call type-checks against the required port member (no widening cast needed). — `tsc --noEmit` (@cap/api) PASS.

## 2. Track: regression-tests (depends: harden-registry)

- [x] 2.1 Add `apps/api/src/agent-runtime/runtime-selection.spec.ts` (node:test → compiled into `dist/**/*.spec.js`): construct the REAL `IntegrationRuntimeRegistry` backed by an in-memory `ProvisionLookup` satisfying the FULL port, asserting `resolveForTask` returns `ClaudeCodeRuntime` for claude-code and `CodexRuntime` for codex / runtime-absent. (spec scenarios 1–2)
- [x] 2.2 Exercise the REAL `PrismaProvisionLookup` with a fake Prisma client; assert `getTaskRuntime` returns the persisted `'claude-code'` value, AND an end-to-end case (real registry + real lookup + fake client) resolves claude. (spec scenario "persistence lookup returns the stored runtime")
- [x] 2.3 Loud-fallback assertions via a `Logger.prototype.warn` spy: out-of-set value, throwing lookup, and unwired lookup each resolve codex AND emit a warn; the legitimate null case resolves codex WITHOUT a warn. (spec scenario "unresolvable runtime is logged, never silently defaulted")
- [x] 2.4 Wire the api unit suite into CI. NOTE (implementation refinement): added a dedicated `pnpm --filter @cap/api test` step to `.github/workflows/ci.yml` rather than a `turbo test` task — the package's `pretest` runs `turbo run build`, so a `turbo test` task would nest turbo inside turbo and trip turbo 2.x's recursive-invocation guard. The direct pnpm step runs the compiled `dist/**/*.spec.js` (the new spec joins it automatically). The ~50 self-compiling `.test.mjs` leaf tests (incl. the codex golden suite) remain OUTSIDE this lane — a documented follow-up, not silently dropped.

## 3. Track: verify (depends: harden-registry, regression-tests)

- [x] 3.1 Red-check (both layers PROVEN): (A) removing `getTaskRuntime` from the port → `tsc` error `TS2339` at `agent-runtime.integration.ts:188` (the typecheck gate catches the DOA class); (B) stubbing `PrismaProvisionLookup.getTaskRuntime` to return `null` → spec tests 4 & 5 FAIL (the test guards the seam, not vacuous). Both reverted via `git checkout`.
- [x] 3.2 `turbo typecheck lint` PASS (12/12); `tsc --noEmit` (@cap/api, uncached) PASS; `pnpm --filter @cap/api test` 57/57 PASS.
- [x] 3.3 Zero behavior change for a wired deployment: full api suite green (existing specs unchanged), and codex / runtime-absent tasks still resolve codex (spec tests 2, 3, 9).
