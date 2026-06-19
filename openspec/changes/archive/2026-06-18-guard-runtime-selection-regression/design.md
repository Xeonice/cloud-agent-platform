## Context

Runtime selection resolves a task's persisted `runtime` to an `AgentRuntime` at provision time:

```
provider.provision(taskId)
  └─ IntegrationRuntimeRegistry.resolveForTask(taskId)        integration.ts:158
        └─ readTaskRuntime(taskId)                            integration.ts:163-179
              const reader = this.lookup as
                (ProvisionLookup & { getTaskRuntime?: ... }) | undefined   // ← vestigial widening cast
              if (typeof reader?.getTaskRuntime !== 'function') return null // ← escape hatch that masked the bug
              ... reader.getTaskRuntime(taskId) ...                          // warn ONLY on throw
        └─ registry.resolve(runtime ?? null)                  registry.ts:49-50  → codex on null
```

In v0.6.0 the `ProvisionLookup` port did not declare `getTaskRuntime`, so the `typeof` guard always tripped, `readTaskRuntime` always returned `null`, and every task — including `runtime=claude-code` — resolved `CodexRuntime`. claude-code was 100% non-functional with no visible signal. #19 added `getTaskRuntime` to the port (`provision-lookup.port.ts:69`, a REQUIRED member, with a docstring naming this exact gap) and to `PrismaProvisionLookup` (`prisma-provision-lookup.ts:74-80`). It was released as v0.7.0 (#20).

But the registry still reads `getTaskRuntime` through the OPTIONAL widening cast + `typeof` guard written in #18 — now vestigial yet load-bearing in the wrong way: it would silently swallow a future removal. And no fast test exercises the real registry↔lookup seam (existing tests use fakes or the create-path; the only real-seam coverage self-skips). See `research-brief.md`.

## Goals / Non-Goals

**Goals:**
- Make a missing/removed `getTaskRuntime` a BUILD-TIME failure (caught by the strict typecheck CI gate #17), not a silent runtime fallback.
- Pin the real create→persist→read→dispatch selection seam with a fast, non-skipping CI test (codex + claude-code).
- Make the remaining legitimate fallback (lookup genuinely unwired / errors / out-of-set value) LOUD (`warn`), never silent.
- Zero behavior change for a correctly-wired deployment — this is purely a regression guard.

**Non-Goals:**
- No change to the selection MECHANISM (correct since #19) or any runtime behavior.
- No contract / DB schema / image / frontend change.
- Not replacing the amd64 compose e2e — it stays the integration backstop.
- Not broadening to a general port-conformance test framework (just the one seam that broke).

## Decisions

### D1 — Depend on the required port member; delete the optional cast + `typeof` guard
`readTaskRuntime` calls `this.lookup.getTaskRuntime(taskId)` directly. The `lookup as (ProvisionLookup & { getTaskRuntime?: ... })` widening cast and the `typeof reader?.getTaskRuntime !== 'function'` branch are removed. Since the port (`provision-lookup.port.ts:69`) declares `getTaskRuntime` as required, any `ProvisionLookup` implementation that omits it is a `tsc` error — exactly the class of regression that shipped in v0.6.0, now caught at build time by the #17 typecheck gate.
- The `@Optional()` injection of `this.lookup` stays: `this.lookup` can still be `undefined` when the port is genuinely not provided (e.g. a unit context). That branch remains, but becomes the ONLY fallback path and is logged (D3).
- **Alternative rejected:** add a runtime assertion that `getTaskRuntime` exists. Rejected — it re-encodes at runtime what the type system already guarantees, and keeps the silent-fallback shape alive.

### D2 — A fast real-seam regression test (the layer the DOA bug slipped through)
Add a unit-lane test (e.g. `agent-runtime/runtime-selection.test.mjs`) that:
- constructs the REAL `IntegrationRuntimeRegistry` with a real-shaped `ProvisionLookup` (an in-memory object satisfying the full port — NOT a partial fake that could drift from the port) and asserts `resolveForTask` returns `ClaudeCodeRuntime` for a `claude-code` task and `CodexRuntime` for a `codex`/absent task;
- constructs the REAL `PrismaProvisionLookup` with a fake Prisma client (mirroring the existing prisma-fake test style) and asserts `getTaskRuntime(taskId)` returns the persisted value — covering the read path #18 omitted.
- **Why both halves:** the registry test proves selection dispatches correctly; the prisma test proves the real implementation actually reads the column. The DOA bug lived precisely between them (registry expected a method the impl didn't expose), so both ends must be pinned. A single fake satisfying the port would not have caught it — hence the real impl is exercised.
- **Alternative rejected:** rely on extending the amd64 compose e2e. Rejected — it self-skips without a token and is not in the CI lane, so it cannot be the regression gate (it stays the integration backstop).

### D3 — Loud fallback on any unresolved selection
`readTaskRuntime` logs at `warn` before returning `null` (→ codex default) for every non-resolving condition: lookup unwired (`!this.lookup`), `getTaskRuntime` throws, or the stored value is outside `{codex, claude-code}`. Today only the throw path warns. The message names the taskId and the reason so an operator sees a runtime-selection degradation instead of a task silently running the wrong agent.
- **Alternative rejected:** fail provisioning closed on an out-of-set value. Rejected — an unknown/forward value should degrade to the safe default (codex), but VISIBLY; failing closed would strand tasks on a benign data-skew.

### D4 — Add a CI unit-test lane (decided at apply time)
A re-review during implementation found the repo's CI runs only `turbo build` + `turbo typecheck lint` — there is NO test execution in CI (`turbo.json` has no `test` task; `.spec.ts`/`.test.mjs` run only locally). So a regression test alone would not GATE anything. The operator chose to add a CI test lane. Implemented as a dedicated `pnpm --filter @cap/api test` step in `.github/workflows/ci.yml`, NOT a `turbo test` task: the `@cap/api` `pretest` already runs `turbo run build --filter=@cap/api` (to build its `@cap/contracts` dep), so a `turbo test` task would nest turbo inside turbo and trip turbo 2.x's recursive-invocation guard. The direct pnpm step is a top-level turbo call (the prior `turbo build` step makes it a cache hit) and runs the compiled `dist/**/*.spec.js` — the new selection spec joins it automatically.
- **Why D1 still matters most:** the typecheck gate already existed in CI, so D1 (compile-enforce the port member) is the layer that gates with zero new infra — it alone would have caught the v0.6.0 DOA at CI time. D4 adds the behavioral gate on top.
- **Known limitation (not silently dropped):** the ~50 self-compiling `.test.mjs` leaf tests (including the codex byte-identity golden suite) are NOT in this lane — wiring them is a larger, separate effort (each spawns `tsc`; collectively slow). Tracked as a follow-up.

## Risks / Trade-offs

- **[Removing the `typeof` guard breaks a build that injects a partial ProvisionLookup]** → Mitigation: the port already requires `getTaskRuntime`; any conformant impl (the only one is `PrismaProvisionLookup`) already has it. A partial test double would now be a typed test fixture — desirable, since that drift is what hid the bug.
- **[The new test pins shape, not real DB behavior]** → Mitigation: the prisma half uses a fake client exactly like the existing prisma-fake tests; the amd64 e2e remains the live-DB backstop. The test's job is to catch the wiring regression, which is shape-level.
- **[Over-fitting: the test asserts current internal types]** → Mitigation: assert on observable resolution (`resolveForTask(...).id`), not internal calls, so a future internal refactor that preserves selection stays green.

## Migration Plan

1. Tighten `readTaskRuntime` (D1 + D3) — pure refactor + logging; no behavior change for a wired deployment.
2. Add the regression test (D2); confirm it FAILS if `getTaskRuntime` is stubbed to return null / removed (a deliberate red check during development), then passes on the real code.
3. Run `turbo typecheck`/`lint`/unit in CI. No data/contract migration; rollback is a plain revert of the two files + the test.

## Open Questions

- Should the louder fallback emit an audit event (not just a log) so a runtime-selection degradation is visible in the operator timeline? Deferred — `warn` logging satisfies the requirement; an audit hook can be a follow-up if operators want it surfaced in the console.
