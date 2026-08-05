# Assertion-rewrite ledger — `extract-runner-minutes-ledger`

> The durable artifact required by `guardrails/Test doubles of the removed accessor are restated and
> every rewrite is ledgered`. The standing rule it serves is the guardrails capability's: outside
> `apps/api/src/guardrails/`, the only permitted edit to a `*.spec.ts` is adding or omitting the
> trailing optional bus argument in a positional `new GuardrailsService(...)` construction — **except
> where the test's own subject is changed by this change**, in which case the rewrite is carried here
> under the same (a)/(b) classification, recording the three things the rule demands: what the
> original assertion pinned, why it no longer holds, and the invariant the replacement pins.
>
> Classification, as the capability defines it:
> **(a)** an implementation detail — replaced by a result assertion over what the completed operation
> produced; **(b)** a real requirement — re-expressed against the new seam and never relaxed.
>
> Scope note: a `.test.mjs` stub restatement is not a spec rewrite and does not earn a row here. The
> three `.test.mjs` doubles this change restates (`metrics.verify.test.mjs:468`, `:537`,
> `task-resource.test.mjs:137`) are ledgered by §2 as provenance, not as rewrites.

## 1. Entries

**One entry.** (Not zero — see §3 for why the count is stated explicitly either way.)

| `file:line` | Class | What the original assertion pinned | Why it no longer holds | Invariant the replacement pins |
|---|---|---|---|---|
| `apps/api/src/metrics/terminal-diagnostics-metrics.service.spec.ts:71` | **(a)** | That `MetricsService` obtains the derived runner-minutes block by calling `runnerMinuteIntervals()` **on its guardrails collaborator** — the test's guardrails double declared `runnerMinuteIntervals: () => []` alongside `semaphoreProjection`, so the double's shape asserted the *route* the read takes, and the fourth positional argument (`undefined`) asserted the constructor's *arity* at 4. | `runnerMinuteIntervals()` was deleted from `GuardrailsService`: the ledger's owner now lives in `runner-metrics` behind `RUNNER_MINUTES_PORT`, and `MetricsService` injects that port as its third constructor parameter. A double that still answered `runnerMinuteIntervals` would be stubbing a method no production caller invokes — green, and testing nothing. | The **route** is now the port: the double is `{ intervals: () => [] }` supplied in the port's own constructor position, so the test fails if `MetricsService` ever reads runner state off guardrails again. The behavioural assertions this test exists for are **unchanged and unweakened** — `parsed.capacity` still deep-equals `{ ceiling: 1, active: 0, free: 1, queueDepth: 0 }`, `terminalDiagnostics.gauges.activeViewers` is still `1`, and `count(attachOutcomes, 'ready')` is still `1`. The empty-intervals fixture value is carried over byte-for-byte, so the derived block's observable value is identical to its pre-change value. |

Why **(a)** and not (b): what changed is *where the collaborator comes from*, an implementation
detail of composition. No assertion about observable output was rewritten, relaxed, made
order-insensitive, or turned into a count — the three assertions in the test body are byte-identical
to their pre-change form. Had the test asserted something about guardrails *owning* the ledger, that
would have been a real requirement and the entry would be (b); it asserted no such thing.

## 2. Provenance — the other three doubles, for completeness

These are `.test.mjs` scripts, not `*.spec.ts`, so the (a)/(b) rule does not reach them. They are
listed because the same restatement was applied and the same fixture values were preserved.

| `file:line` (pre-change) | Original stub | Restated as | Fixture value preserved |
|---|---|---|---|
| `apps/api/src/metrics/metrics.verify.test.mjs:468` | `runnerMinuteIntervals: () => [{ taskId: 't1', startedAt: 0, endedAt: 60_000 }]` on the guardrails double | `const runnerMinutes = { intervals: () => [{ taskId: 't1', startedAt: 0, endedAt: 60_000 }] }`, passed in the port's constructor position | yes — same single closed 60 s interval |
| `apps/api/src/metrics/metrics.verify.test.mjs:537` | `runnerMinuteIntervals: () => []` on the guardrails double | `const runnerMinutes = { intervals: () => [] }`, passed in the port's constructor position at **both** construction sites in that test (the served and the degraded builds) | yes — empty ledger |
| `apps/api/src/metrics/task-resource.test.mjs:137` | `runnerMinuteIntervals: () => []` on the guardrails double | `const runnerMinutes = { intervals: () => [] }`, passed in the port's constructor position | yes — empty ledger |

Every assertion in all three files is unchanged. The identifier `runnerMinuteIntervals` now appears
**zero** times under `apps/api/src` (task 4.14), which is what makes these restatements complete
rather than partial.

## 3. Count

Entries: **1**. Class (a): 1. Class (b): 0. Guardrails-directory spec or `.test.mjs` files edited:
**0** — the guardrails characterization baseline (135 `test()` across 6 `*.spec.ts`, 8 `.test.mjs`)
is untouched by this change, and `guardrails.service.spec.ts` in particular is at zero diff.
