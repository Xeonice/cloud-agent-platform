# Pre-change baseline

Captured on the working tree at `12ce743`, before any task in this change was
applied. Task 4.2 compares against the "no existing test modified" rule; task 4.4
compares against the admission-cost measurement in §3.

## Suites (task 1.1)

| suite | result |
|---|---|
| `@cap/contracts` | 229 / 229 pass |
| `@cap/api` test:compiled | 1596 run, 1592 pass, 4 skipped, 0 fail |
| `@cap/api` test:src | 300 / 300 pass |
| `@cap/api` test:suite | 12 run, 11 pass, 1 skipped, 0 fail |

## The three statements, with line numbers (task 1.1)

```
packages/contracts/src/task.ts:61      RuntimeSchema = z.enum(['claude-code','codex'])
packages/contracts/src/task.ts:62      type Runtime = z.infer<typeof RuntimeSchema>
packages/contracts/src/task.ts:78      DEFAULT_TASK_RUNTIME = 'codex' as const satisfies Runtime
apps/api/.../agent-runtime.port.ts:37  type RuntimeId = 'codex' | 'claude-code'
apps/api/.../agent-runtime.port.ts:58  DEFAULT_RUNTIME_ID: RuntimeId = 'codex'
apps/api/.../agent-runtime.integration.ts:150
                                      new AgentRuntimeRegistry([new CodexRuntime(), new ClaudeCodeRuntime()])
```

Nothing compares any of them. `grep` for `RuntimeSchema.options` / `AGENT_RUNTIME_IDS`
/ `registeredIds` / `.ids()` across `apps/api/src` and `packages/contracts/src`
returns **zero** hits.

### `RuntimeSchema` consumers — must be unedited by hand (task 2.4 / 4.2)

| file | line | position |
|---|---|---|
| `contracts/task.ts` | 319 | `runtime: RuntimeSchema` |
| `contracts/task.ts` | 755 | `runtime: RuntimeSchema.nullable().optional()` |
| `contracts/task.ts` | 990 | `runtime: RuntimeSchema.optional()` |
| `contracts/schedule.ts` | 183 | `runtime: RuntimeSchema.default(DEFAULT_TASK_RUNTIME)` |
| `contracts/runtime.ts` | 27 | `id: RuntimeSchema` — the readiness response |
| `contracts/runtime-model.ts` | 12, 267, 289 | `runtime: RuntimeSchema` ×3 |
| `contracts/public-v1-operations.ts` | 101 | `runtime: RuntimeSchema` |
| `api/sandbox/prisma-provision-lookup.ts` | 169, 330 | `safeParse` / `parse` |

## Enabling facts, re-derived from source (task 1.3)

| claim in the design | verified |
|---|---|
| `Task.runtime` has no DB-level constraint | `schema.prisma:178` — `runtime String? @map("runtime")` |
| the console reads the runtime list at runtime | `apps/web/src/lib/api/real.ts:760` — `GET /runtimes` feeds the create-task dialog selector |
| no exhaustive `switch` on the runtime union | `grep "case 'codex'\|case 'claude-code'"` across `apps` + `packages`, excluding specs → **0 hits** |
| the provider axis already has the target shape | `contracts/provider-family.ts:17` `SANDBOX_PROVIDER_FAMILIES` `as const`, consumed by `sandbox-environment.ts:19` and `task-provisioning-diagnostics.ts:54` |
| zod accepts the spelling | `zod ^3.23.8`; `z.enum([...SANDBOX_PROVIDER_FAMILIES, 'unknown'])` already compiles in-repo |

All five hold. The design rests on them and none required adjusting.

## Admission cost measured today (task 1.2)

Method: add the throwaway identifier `opencode` to each statement in turn, run
the api and web typechecks, record what the compiler demands. Reverted after.

### Correction: there are FOUR statements, not three

The proposal was written against three. The web app declares a fourth, and it
does so *while already depending on `@cap/contracts`*:

```
packages/contracts/src/task.ts:61            z.enum(['claude-code','codex'])
apps/api/.../agent-runtime.port.ts:37        type RuntimeId = 'codex' | 'claude-code'
apps/api/.../agent-runtime.integration.ts:150  new AgentRuntimeRegistry([...])
apps/web/src/lib/api/real.ts:155             type RuntimeId = "claude-code" | "codex"
```

### Experiment A — widen only the contract

Four errors. Three are total `Record<Runtime, …>` policy tables (below); the
fourth is the drift itself:

```
terminal/terminal.gateway.ts(1499,40): error TS2345:
  Argument of type '"codex" | "claude-code" | "opencode"' is not assignable to
  parameter of type 'RuntimeId | null | undefined'.
```

That error exists *only because* the two vocabularies are separate. It reports the
symptom at a terminal gateway call site, far from the two declarations that
actually disagree.

### Experiment B — widen the contract and the api union

The gateway error disappears. Six compiler-demanded edits remain, and every one is
a total `Record` keyed by the runtime union:

| file | line | table |
|---|---|---|
| `agent-runtime/runtime-model-rejection-evidence.ts` | 37, 47 | CLI version pins |
| `agent-runtime/runtime-model-rejection-evidence.spec.ts` | 36 | its fixture |
| `runtime-models/prisma-runtime-model-credential.resolver.ts` | 44 | credential resolution per runtime |
| `runtime-models/runtime-model-catalog.port.ts` | 118 | catalog adapter descriptors |
| `sandbox-environments/sandbox-environments.validator.ts` | 474 | probe name / executable |
| `web/src/lib/runtime-label.ts` | 22 | display label |

**These six are not defects.** Each is a genuine per-runtime decision that the
repository's total-mapping pattern is correctly forcing someone to make. Task 4.4
must judge the demanded-edit list against the *vocabulary* statements, not against
these.

### The gap this change exists to close

With all four vocabularies widened and all six tables filled, the project compiles
— **without any implementation having been registered**. Nothing checks that a
declared runtime has a registered implementation; the failure surfaces at task
launch as `AgentRuntimeRegistry: no runtime registered for "opencode"`.

So today:

| | today | target |
|---|---|---|
| vocabulary statements to edit | **4**, hand-kept in agreement | **1** |
| wrong-edit failure mode | assignability errors far from the cause | impossible — one declaration |
| registration | **not checked at all** | compile-enforced |
| per-runtime policy tables | 6, compiler-enforced | 6, unchanged (correct as-is) |

## Negative control on the totality guard (task 3.4)

Removing `'claude-code': new ClaudeCodeRuntime(),` from
`AGENT_RUNTIME_IMPLEMENTATIONS`:

```
apps/api/src/agent-runtime/agent-runtime.integration.ts(162,7): error TS2741:
  Property '"claude-code"' is missing in type '{ codex: CodexRuntime; }'
  but required in type 'Readonly<Record<"claude-code" | "codex", AgentRuntime>>'.
```

Restoring the entry returns the api typecheck to 0 errors. The guard is proven to
fire rather than asserted to.

## Admission cost re-measured after the change (task 4.4)

Same method as §3: add `opencode`, record the compiler's demands, revert.

Editing **the one declaration** now demands:

| file | line | kind |
|---|---|---|
| `agent-runtime/agent-runtime.integration.ts` | 162 | **the registration** — new; not demanded at all before |
| `agent-runtime/runtime-model-rejection-evidence.ts` | 37, 47 | policy table (CLI pins) |
| `agent-runtime/runtime-model-rejection-evidence.spec.ts` | 36 | its fixture |
| `runtime-models/prisma-runtime-model-credential.resolver.ts` | 44 | policy table |
| `runtime-models/runtime-model-catalog.port.ts` | 118 | policy table |
| `sandbox-environments/sandbox-environments.validator.ts` | 474 | policy table |
| `web/src/lib/runtime-label.ts` | 22 | policy table |

**Zero further vocabulary statements are demanded.** The seven policy tables are
the same seven recorded in §3 and are correct as they are — each is a per-runtime
decision the total-mapping pattern is right to force.

| | before | after |
|---|---|---|
| vocabulary statements to hand-edit | **4** | **1** |
| registration checked | **no** — compiled clean, failed at task launch | **yes** — `TS2741` at the wiring |
| failure mode of a partial edit | assignability errors at unrelated call sites | not representable |
| per-runtime policy tables demanded | 7 | 7 (unchanged, by design) |

The goal stated in the proposal — one declaration plus one registration — is met,
and the registration half is enforced rather than remembered.

## Remaining independent enumerations (task 4.5)

The grep for a surviving *definition* of the set returns nothing. But 4.5's real
job is the opposite case — a hand-written enumeration that does **not** fail when
the declaration grows, because a narrower list assigns cleanly to a wider union.
Two were found, and both were silent:

**1. `apps/api/src/runtimes/runtimes.service.ts`** — a fifth statement
(`id: 'codex' | 'claude-code'`) carrying the same stale note the console had
("declared here as a local fallback… even before the contract type is wired
through"), plus a hand-written two-entry response list. A newly declared and
registered runtime would be accepted by the API and resolved by the registry, then
never appear in `GET /runtimes` — so the console, which builds its selector from
that response, would never offer it. Nothing failed anywhere. Replaced by a total
`Record<AgentRuntimeId, …>` readiness policy. The service had **zero tests**;
three were added (`runtimes.service.spec.ts`).

**2. `apps/web/.../new-task-dialog.tsx`** — `RUNTIME_CATALOG`, a hand-written
array of picker options, silently incomplete for the same reason, and a seventh
spelling of the default. Rebuilt from a total `Record` of per-runtime copy, so a
runtime without console copy is now a build error — matching what
`runtime-label.ts` next door already did correctly.

Twelve non-test files still contain both runtime literals. All are per-runtime
policy — the六 tables §4 measured plus the two rebuilt here — which is the pattern
working, not a defect.

### One observable difference, stated rather than hidden

`GET /runtimes` now emits entries in declaration order (`claude-code`, `codex`)
where it previously emitted `codex` first. Nothing consumes the order: the console
reduces the response to a `Map` keyed by id, and no test or OpenAPI surface
asserts it. The console's own picker order is unchanged — it is now ordered
default-first as an explicit presentation rule, so reordering the contract
declaration cannot silently reorder the dialog.

## Final verification (task 4.1–4.3)

| | |
|---|---|
| `@cap/api` | 1599 / 1595 pass / 4 skipped / **0 fail** (+3 new) |
| `@cap/api` test:src, test:suite | 300 / 300, 12 / 11 + 1 skipped, 0 fail |
| `@cap/contracts` | 229 / 229 |
| typecheck (api, web), lint (api, web) | clean |
| existing test files modified | **0** |
| `api-module-layout-check` | pass, `ALLOWED_CYCLES` empty |
| `test-discovery-check` | 452 files, all mounted (451 before + the new spec) |
