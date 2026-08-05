# Verification report — `extract-runner-minutes-ledger`

Adversarial verification with three-way routing (UNMET → re-opened code task ·
SPEC-DEFECT → `design.md` Open Questions · MET → folded here). Every verdict below was
**re-traced against the working tree**, not copied from the skeptic pass and not copied
from the apply log or from `gate-results.md`. Where a gate is quoted, this pass ran it.

Tree under test: branch `refactor/extract-runner-minutes-ledger`, commits `295fa46`
(characterization test) + `cce2b2d` (ownership move), base `main` = `e5d4e5a`.
Date: 2026-08-05.

---

## Adjudicated tally

| Route | Count | Ids |
|---|---|---|
| Re-opened as code tasks (UNMET) | **2** | `runner-minutes-accounting/the-derived-output-is-proven-unchanged-by-a-characterization-test-bound-to-the-real-implementation`, `guardrails/test-doubles-of-the-removed-accessor-are-restated-and-every-rewrite-is-ledgered` |
| Routed to `design.md` Open Questions (SPEC-DEFECT) | **0** | — |
| Archive-blocking spec defects (public impact / false exclusion) | **0** | — |
| Reclassified MET (raw-unmet that re-traces end-to-end) | **0** | — (the skeptic pass produced zero raw-unmet requirements) |

The skeptic pass produced **0 raw-unmet requirements** and **0 mandatory public findings**.
This pass did **not** rubber-stamp that: all 14 requirements were re-traced against the
tree, and the pass's own scope audit surfaced one defect the skeptic's requirement-by-
requirement sweep did not route — an unauthorized `*.spec.ts` sitting inside the frozen
guardrails directory. Both requirements it breaks are re-opened as task **6.1**. The
tally above is this pass's adjudication, not the raw skeptic count.

Twelve of the fourteen requirements are **MET** and are folded in below.

---

## Gates actually executed on this tree during this pass

| Gate | Result |
|---|---|
| `node scripts/ratchets/r11-dependency-budget.mjs` | **exit 0** — `this.audit: 9`, `this.runnerMinutes: 5`, `provisioningDiagnosticRecorder: 4`, `provisioningDiagnosticWriteGate: 4`, `this.transcripts: 2`, `metrics-projection: 2`; "every collaborator exactly at its baselined count" |
| `node --test --test-force-exit scripts/ratchets/r11-dependency-budget.test.mjs` | **12 pass / 0 fail** |
| `node scripts/context-layout-check-v2.mjs` | **exit 0** — scanned 285 files; `cross-context-import: 135 / layer-direction: 2 / prisma-outside-store: 60 / unclassified-file: 132`; "every class within its committed baseline" |
| `node scripts/test-discovery-check.mjs` | **489 test files, all discovered by a runner** |
| `node scripts/public-surface-adversarial.mjs verify extract-runner-minutes-ledger --phase verify` | **exit 0** — `sidecar`, `registry`, `restMetadata`, `mcpSdkMetadata`, `behavior` all `passed: true`, **`findings: []`** |
| `grep -n 'this\.runnerMinutes' apps/api/src/guardrails/guardrails.service.ts` | 5 refs — `1871, 2366, 2964, 3311, 3333` (byte-identical to `r11.json` `samples`) |
| `grep -rn 'runnerMinuteIntervals' apps/api/src` | **zero matches**, production and test doubles alike |
| `grep -rn 'createDetachedRunnerMinutes(' apps/api/src` | one production call site — `guardrails.service.ts:615`; the other four are the port's own declaration and its `.port.test.mjs` |
| `grep -niE 'admission\|fence\|lease\|semaphore\|queued' …/runner-minutes-ledger.port.ts` | **zero matches** |
| `grep -n 'Logger\|console\.'` over port + service + module | **zero matches** |
| `ls apps/api/src/guardrails/*.spec.ts \| wc -l` | **7** — expected 6 · see UNMET §1 |
| `grep -ho 'test(' apps/api/src/guardrails/*.spec.ts \| wc -l` | **136** — expected 135 · see UNMET §1 |
| `ls apps/api/src/guardrails/*.test.mjs \| wc -l` | **8** — correct |

Live guardrails baseline, re-measured this pass, per file:

```
guardrails.service.spec.ts                          57
guardrails-durable-launch-decision.spec.ts          54
guardrails-domain-event-publishing.spec.ts          15
guardrails-branch-policy.spec.ts                     3
semaphore-restore.spec.ts                            3
transfer-progress-throttle.spec.ts                   3
                                        subtotal = 135  across 6 files   ← the pinned baseline
ground-truth-publishing-failure-does-not-disturb-
  transition.spec.ts                                 1   ← UNAUTHORIZED, untracked
                                           total = 136  across 7 files
```

`tasks.md` before this pass: **71 / 71 checked, zero open items**, across 5 tracks
(`owner-and-port`, `characterization-proof`, `range-b-research`,
`ownership-move-and-ratchet`, `gates-and-verification`). This pass appended one open
item (6.1) under a new `verify-reopened` track.

---

## UNMET — re-opened as code tasks

### 1. `runner-minutes-accounting/the-derived-output-is-proven-unchanged-by-a-characterization-test-bound-to-the-real-implementation` — **UNMET** (task 6.1)

Three of this requirement's four scenarios re-trace clean (see below). The fourth does not.

> **Scenario: The guardrails characterization baseline is untouched**
> **WHEN** the `test()` cases in `apps/api/src/guardrails/*.spec.ts` and the `.test.mjs`
> scripts in that directory are counted **on the integrated tree**
> **THEN** the counts are still 135 across 6 spec files and 8 `.test.mjs` scripts, so no
> test this change adds landed inside the guardrails baseline

Measured on the integrated tree: **136 across 7 spec files**. The extra file is
`apps/api/src/guardrails/ground-truth-publishing-failure-does-not-disturb-transition.spec.ts`
— a real, runnable 229-line spec that drives the actual `GuardrailsService` through
admit → onTerminal with a throwing bus. It is currently **untracked** (`git status` `??`),
but it is present and functioning, its own header names
`extract-runner-minutes-ledger`, and no task in `tasks.md` authorizes it. Excluding that
one file, both counts land back on exactly **6 files / 135 `test()`**, which is what makes
the attribution unambiguous rather than a drifted baseline.

The remaining scenarios of this requirement are satisfied and are *not* what re-opens it:

- **The equivalence fixture pins the whole object with a frozen clock** — `runner-minutes-derivation.test.mjs` asserts deep equality on the complete `{ available, minutes }` for each fixture, including the empty case as exactly `{ available: false, minutes: null }`.
- **The characterization test binds to the real implementation** — it loads the compiled `dist/runner-metrics/runner-minutes.js` (the way `metrics.verify.test.mjs` already loads `dist/`) and its header carries an explicit hard constraint against importing anything the ownership move introduces. It does not re-declare `deriveRunnerMinutes` or the ledger locally, and it explicitly refuses `apps/api/src/metrics/runner-minutes.test.mjs` as the proof, naming that file's self-declared `:13` mirror.
- **It passes unmodified across the ownership move** — `git show --stat 295fa46` is that one file alone (267 insertions); `git show --stat cce2b2d` does not touch it. The ordering is exactly "proof first, move second".
- **The new tests are actually discovered** — `node scripts/test-discovery-check.mjs` reports 489 test files, all discovered by a runner.

**Fix scope:** delete or relocate the one file. Do **not** satisfy it by editing the 135 / 6
numbers in either spec — the frozen baseline is the requirement.

### 2. `guardrails/test-doubles-of-the-removed-accessor-are-restated-and-every-rewrite-is-ledgered` — **UNMET** (task 6.1)

Three of this requirement's four scenarios re-trace clean. The fourth does not.

> **Scenario: No guardrails-directory test is edited**
> **WHEN** the change's diff is filtered to `apps/api/src/guardrails/*.spec.ts` and
> `apps/api/src/guardrails/*.test.mjs`
> **THEN** zero files appear

`git show --stat` on both commits shows zero guardrails test files, so the **committed**
diff is clean. But the same untracked spec above is part of this change's contribution to
the tree — it names the change in its own header — and it would enter the diff the moment
archive stages the working tree. Under the reading that "the change's diff" means what the
change contributes, one file appears where zero must.

This also makes the change's own durable artifact false as written. `assertion-rewrite-ledger.md`
§3 states: *"Guardrails-directory spec or `.test.mjs` files edited: **0** — the guardrails
characterization baseline (135 `test()` across 6 `*.spec.ts`, 8 `.test.mjs`) is untouched
by this change."* On the live tree that sentence does not hold. The ledger needs no edit —
removing the file makes it true again, which is the correct direction of repair.

The remaining scenarios are satisfied:

- **Every stub moves to the port with its strength intact** — all four doubles restated: `metrics.verify.test.mjs:468` (single closed 60 s interval preserved), `:537` (empty ledger, at **both** construction sites in that test), `task-resource.test.mjs:137` (empty ledger), `terminal-diagnostics-metrics.service.spec.ts:71` (empty ledger). Each now supplies `{ intervals: () => … }` in the port's constructor position rather than a fake guardrails accessor, and each keeps its pre-change fixture values.
- **The changed-subject spec carries a classified ledger entry** — `assertion-rewrite-ledger.md` §1 holds exactly one entry, `terminal-diagnostics-metrics.service.spec.ts:71`, classified **(a)**, recording what the original pinned (the *route* through the guardrails collaborator plus the 4-arity), why it no longer holds (`runnerMinuteIntervals()` deleted; a double answering it would be green and testing nothing), and the invariant the replacement pins (the route is now the port; the three behavioural assertions are byte-identical). The (a)-vs-(b) reasoning is stated, not just the label.
- **The ledger is never silently empty** — §3 states the count explicitly (`Entries: **1**. Class (a): 1. Class (b): 0.`), and §1 opens with "**One entry.** (Not zero — see §3 for why the count is stated explicitly either way.)"

---

## SPEC-DEFECT — routed to `design.md` Open Questions

**None.** No requirement in this change was found ambiguous, untestable, or
self-contradictory. In particular, every requirement that could have been written as an
unfalsifiable prose claim carries its own executable gate: the public-surface position
names `node scripts/public-surface-adversarial.mjs verify` rather than asserting
`unchanged` in prose; the R11 outcome names `measureSource` over the post-change file
rather than a count of deleted call sites; and the replacement acceptance criteria each
name the command that decides them **plus** whether that gate exists today.

## Archive-blocking spec defects (undeclared public impact / false protocol exclusion)

**None.** The `unchanged`-on-all-four-surfaces position in `surface-impact.json` was
**executed**, not taken on trust:
`node scripts/public-surface-adversarial.mjs verify extract-runner-minutes-ledger --phase verify`
exits 0 with `sidecar`, `registry`, `restMetadata`, `mcpSdkMetadata` and `behavior` all
`passed: true` and `findings: []`, against an empty `protocolDifferences`. `git diff` over
`packages/contracts/**` is empty. The sidecar claim is true.

---

## MET — the twelve requirements that re-trace end-to-end

### `runner-minutes-accounting/running-interval-state-has-exactly-one-owner-and-it-lives-in-platform-ops` — **MET**

`RunnerMinutesLedgerService` (`apps/api/src/runner-metrics/runner-minutes-ledger.service.ts`)
holds `private readonly ledger = new RunnerMinutesLedger()` — a private field of a DI
provider, not a module-level singleton, and the file exports zero module-level mutable
instances. `runner-minutes.module.ts` provides it under `RUNNER_MINUTES_PORT` and exports
**only** the token, so an importing module can inject the port but cannot reach the class.

`guardrails.service.ts` imports only from `@/runner-metrics/runner-minutes-ledger.port`
(`:113`) — never the concrete class — and models the member as required:
`private ownedRunnerMinutes?: RunnerMinutesPort` (`:601`),
`private readonly detachedRunnerMinutes: RunnerMinutesPort = createDetachedRunnerMinutes()`
(`:614`-`:615`, a **field initializer**, so it is in place before the constructor body runs),
and `private get runnerMinutes(): RunnerMinutesPort { return this.ownedRunnerMinutes ?? this.detachedRunnerMinutes; }`
(`:628`-`:629`). The owner is resolved at `:848` inside the pre-existing `onModuleInit`
`ModuleRef` resolution. Neither backing member name matches the ratchet's `\b`-anchored
`this.runnerMinutes` regex — confirmed by the gate's own count returning 5, not 6.

Skeptic's refutation considered: *"`grep -rn 'new RunnerMinutesLedger(' apps/api/src` returns
four matches in `apps/api/src/metrics/runner-minutes.test.mjs`, outside `runner-metrics/` —
the scenario says every match must be inside it."* Re-traced and **rejected**: that file
declares its **own local** `class RunnerMinutesLedger` at `:26` (its `:13` header says
"inline the pure function + ledger (mirror runner-minutes.ts)"), imports nothing, and is
**pre-existing and untouched** — `git show 295fa46^:…/runner-minutes.test.mjs | grep -c` returns
the same 4. Those are constructions of a same-named local mirror, not second construction
sites of the owner's ledger. The requirement's substance — guardrails neither imports nor
constructs the concrete class, and exactly one instance owns the state — holds. This is
met-as-written with a minor literal-text gap in the scenario's glob wording that does not
touch the primary scenario.

The single-instance and bypass claims are proven by execution, not assertion:
`runner-minutes-ownership.integration.test.mjs` boots a real Nest application context and
asserts `service.runnerMinutes` is **object-identical** to `app.get(RUNNER_MINUTES_PORT)`
(not merely equal), that the field-initializer fallback reports `intervals() === []` after
boot (bypassed, not replaced in place), and — as the reverse control — that in a context
**without** `RunnerMinutesModule` the fallback still genuinely records
(`intervals().length === 1`), which is what stops the frozen spec's seven *negative*
assertions from being satisfied vacuously by a no-op shell.

### `runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token` — **MET**

The port declares exactly three methods (`recordStart`, `recordEnd`, `intervals`) and no
fourth member. Its exports are exactly three symbols: `RunnerMinutesPort`,
`RUNNER_MINUTES_PORT`, `createDetachedRunnerMinutes`. `RunnerMinutesLedger` and
`RunningInterval` are **imported** for typing/construction but neither is exported or
re-exported — verified by reading the file, not by grepping for `export`.

`createDetachedRunnerMinutes(` has **exactly one production call site**:
`guardrails.service.ts:615`, the fallback backing member's initializer. The other three
occurrences are the port's own `export function` and two lines inside
`runner-minutes-ledger.port.test.mjs`.

Vocabulary scan for `admission|fence|lease|semaphore|queued`, case-insensitive, over the
port file: **zero matches** — including the `lease`-inside-`release` trap, which does not
fire because the file never says "release".

All three added files carry classified suffixes (`.port.ts`, `.service.ts`, `.module.ts`).
The stale-entry trap is not sprung: `node scripts/context-layout-check-v2.mjs` exits 0, and
`unclassified-file:apps/api/src/runner-metrics/runner-minutes.ts` and
`…/metrics-projection.ts` are both still present in `r7.json` with count 1 — neither bare
file was renamed, moved, or deleted. `unclassified-file` totals 132 with **no new key**.

### `runner-minutes-accounting/the-metrics-reader-calls-the-owner-directly-and-no-forwarder-survives` — **MET**

`grep -rn 'runnerMinuteIntervals' apps/api/src` returns **zero matches** — the identifier is
gone from production code and from every test double. `metrics.service.ts` imports
`RUNNER_MINUTES_PORT` and `type RunnerMinutesPort` from
`@/runner-metrics/runner-minutes-ledger.port` (`:17`-`:19`), injects the port as a
**required** (not `@Optional()`) constructor parameter at `:58`-`:59`, and at `:88` computes
`runnerMinutes: deriveRunnerMinutes(this.runnerMinutes.intervals(), now)`. No expression in
the file reads runner state off the guardrails collaborator. No replacement forwarder was
introduced anywhere — the accessor was deleted outright, and with zero occurrences of the
identifier there is nothing left that could be an uncalled delegator.

r7 confirms the direction of both counts and that nothing else moved:
`cross-context-import:apps/api/src/guardrails/guardrails.service.ts` reads **8** (down from 9,
the ledger import now being a legal `*.port.ts` form) and
`cross-context-import:apps/api/src/metrics/metrics.service.ts` still reads **2**. Because the
comparator is **bidirectionally fail-closed** — a measured count *below* baseline is equally
red — `context-layout-check-v2.mjs` exiting 0 pins these as live equalities, not ceilings.
No count rose; no new key appeared.

### `runner-minutes-accounting/the-ownership-move-adds-no-runtime-behavior-and-no-observable-output-change` — **MET**

`grep -n 'Logger\|console\.'` over the port, the owner and the module: **zero matches**;
none takes an injected logger parameter. The owner adds no persistence, no metrics
emission, no timer, no retry and no error handling — it delegates all three methods to the
private ledger verbatim, which is visible on inspection of a 34-line file.

The ledger's recorded semantics (idempotent start, no-op end for a never-started task,
clock skew clamped to 0 rather than subtracting, closed-then-open snapshot order) are
exercised through the port on the integrated tree by `runner-minutes-derivation.test.mjs`
and `runner-minutes-ledger.port.test.mjs`, and both files are reported as executed by the
discovery gate.

The byte-identical response-body claim is backed by a **cross-build** experiment, not by
reasoning: `gate-results.md` §5.11 records checking out `main`'s five files, building,
snapshotting `dist/` to `.premove-dist/` (whose `metrics.service.js:39` is the pre-move
`deriveRunnerMinutes(this.guardrails.runnerMinuteIntervals(), now)`), restoring the
post-move files, rebuilding (`:41` becomes `deriveRunnerMinutes(this.runnerMinutes.intervals(), now)`),
then `require`-ing **both** `MetricsService` builds in one process against the same fixture
and the same frozen `now` and `assert.deepEqual`-ing the complete bodies — `FULL RESPONSE
BODIES DEEP-EQUAL: PASS`, same five top-level keys, `runnerMinutes` `{available:true,minutes:8}`
on both sides. That one-shot evidence is correctly backed by a resident regression in
`runner-minutes-ownership.integration.test.mjs`, which pins both the derived value against
the pre-move read expression over the same fixture *and* the literal
`{ available: true, minutes: 8 }`, so "break both sides identically" does not pass.

The public-surface position was **executed** by this pass, not quoted: exit 0, all five
checks `passed: true`, `findings: []`.

### `domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts` (MODIFIED) — **MET**

`node scripts/ratchets/r11-dependency-budget.mjs` exits 0 with every recorded count equal
to a live re-count. Its 12-case test passes. Fail-closed in both directions is exercised by
that test file, which this change updated in the **same commit** as `r11.json` (`cce2b2d`
contains both). The per-collaborator / per-change reconciliation discipline holds: the
`this.runnerMinutes` entry carries the delta reconciliation in its `change` field, and the
other five entries are byte-identical to their form at the start of this change (`this.audit`
9, `provisioningDiagnosticRecorder` 4, `provisioningDiagnosticWriteGate` 4,
`this.transcripts` 2, `metrics-projection` 2, unchanged in count and in `symbol`). The
entry was reduced, never deleted, its live count still being above zero.

### `domain-event-bus/the-runner-minutes-budget-entry-falls-from-6-to-5-as-a-measured-first-decrease-not-a-burn-down` — **MET**

`r11.json:19-31`: `count: 5`, `symbol: "this.runnerMinutes"` (unchanged — no rename, so no
forged burn-down), and `samples` refreshed to the five live line numbers
`1871 / 2366 / 2964 / 3311 / 3333`, which match `grep -n` on the post-change file exactly and
carry **zero** lines from the stale generation (`1566/2038/2623/2949/2971/3555`). The
`change` field states 6 − 5 = 1 equals the single removed read
`return this.runnerMinutes.intervals();`, names the removed accessor's original site, states
that the count was obtained by running the gate's own `measureSource` over the post-change
file rather than by counting deleted call sites, and enumerates what does **not** contribute
an occurrence (the getter, `ownedRunnerMinutes` / `detachedRunnerMinutes`, the `onModuleInit`
resolution, every added comment). It states 6 → 0 is structurally unreachable and calls the
result a **first decrease**, never a burn-down.

The event-route ceiling is recorded in `research-findings.md` §6 as **1, not 0**, citing the
`clearAdmissionRuntime` `recordEnd` as the one reference no event may lawfully cover
together with the standing requirement forbidding a `TaskSettled` publish at that seam, and
§6.1 names both further costs measured on this tree — that the reflective runner-minutes
assertions are all *negative* and would pass **vacuously** rather than fail if guardrails
stopped recording, and that subscriber-driven accounting becomes fail-open under the publish
escape hatch. `scripts/ratchets/r11-dependency-budget.test.mjs` moved in the same commit and
passes with its expected mapping at 5.

### `guardrails/the-runner-minutes-read-face-is-removed-under-a-proven-owner-while-every-write-is-retained` — **MET**

`git diff` on `guardrails.service.ts` filtered to `this.runnerMinutes` shows exactly one
deletion hunk (the accessor's `return this.runnerMinutes.intervals();`, deleted with its doc
comment) and zero modification hunks. The five survivors are byte-identical
(`this.runnerMinutes.recordStart(taskId);` ×3 at `1871/2964/3333`,
`this.runnerMinutes.recordEnd(taskId);` ×2 at `2366/3311`) and each still sits in the method
it sat in before. The live symbol-reference count on the integrated tree is exactly **5** —
not fewer — so the change did not quietly widen past the read face.

The proof offered is the executable characterization test over the real `deriveRunnerMinutes`
fed by the owner's `intervals()`; no part of it rests on an event having been published, and
the test file's own header forbids importing anything the move introduces. Added comments in
`guardrails.service.ts` were searched for quoted catalog event names: zero matches, so the
publishing spec's whole-file text-scanning assertions stay pinned.

### `guardrails/in-place-and-unchanged-governs-the-seam-and-this-change-keeps-the-call-text-byte-identical-anyway` — **MET**

Each of the three `TaskRunStarted` publish points still has its retained
`runnerMinutes.recordStart(taskId)` in the same method on the same side of the publish; no
call site moved methods. Both `recordEnd` seams still run — `fenceTerminal` and
`clearAdmissionRuntime` — and `clearAdmissionRuntime` still publishes zero `TaskSettled`.
The accessed symbol is still literally `this.runnerMinutes` at all five sites, so the
recorded decrease reflects a deleted reference rather than a symbol the regex stopped
matching. Every edited line touching the member is part of its **declaration** (`:601`,
`:614`-`:615`, `:628`-`:629`, `:848`); zero call-site lines were edited. The gate's own
`measureSource` over the post-change file returns 5 — neither the getter body, the backing
declarations, the `onModuleInit` resolution, nor any added comment contributes an occurrence.

### `guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched` — **MET**

The constructor keeps its 11 parameters in order and type with the `@Optional()` bus last;
`cce2b2d` edits no positional `new GuardrailsService(...)` site to pass a ledger or port
argument. The diff touches `guardrails.service.ts` alone under that directory, in exactly
four hunks — the port import (`@@ -107`), the member declaration region (`@@ -583`), the
`onModuleInit` resolution (`@@ -807`), and the accessor deletion (`@@ -3874`) — and
`git diff … | grep -iE 'constructor|@Optional'` over added and removed lines returns
nothing, so the signature is untouched at the byte level. The member is usable from
the moment an instance exists under **both** construction modes because the fallback is a
**field initializer** (`:614`), which the compiler emits before the constructor body runs —
so it is in place before any collaborator the constructor builds can reach it. The
integration test's reverse control (a context without `RunnerMinutesModule`) demonstrates a
positionally-reachable instance recording start and end and returning the closed interval
with no null-reference error.

### `guardrails/the-phase-4-numeric-acceptance-target-is-replaced-by-criteria-that-each-name-their-gate` — **MET**

All three plan documents were edited **by this change** rather than deferred:
`docs/refactor-master-plan.md` (+32/−…), `docs/refactor/08-ddd-target-architecture.md`,
`docs/refactor/07-baselines-and-dependencies.md`; archived change directories are untouched.
The old `guardrails 3,806 → <2,000 行` acceptance line is gone, replaced by a four-row table
(a–d) in which **every row names the command or gate that decides it and its status**:
(a) `pnpm test:dependency-budget` — measurable today, zero code change; (b) same gate,
requires one *data* addition to `COLLABORATORS`; (c) `pnpm test:context-layout-v2` —
measurable today; (d) explicitly **今天无闸门**, carrying the concrete work that would give it
one (a narrow check reading only `guardrails.module.ts` / `tasks.module.ts` and asserting zero
mutual `forwardRef(`). Both rejected candidates are recorded with their reasons — symbol
references burning to zero (unreachable while the orchestrator legitimately names collaborators
it still calls) and a bare "forwardRef cycle to zero" (no gate measures it, because the layout
check exempts cycles formed only of `*.module.ts` files, which is exactly why criterion (d) is
phrased as a two-named-file count instead). Every surviving occurrence of the old number is
explicitly labelled a historical review-time baseline (`〔**历史基线**：3,806 是**评审时点**的
实测值…〕`), and the line count is retained as trend data only — stated verbatim as
「行数只作趋势数据，不是验收判据」, with no acceptance item depending on it crossing a threshold.

### `guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table` — **MET**

`research-findings.md` is the durable artifact, in the change directory. §1 is the Mikado
precondition graph; §2 the outcome table over the five dimensions this change actually
measured; §3.1-§3.5 are the per-node detail tables for legacy inline-admission retirement,
diagnostics, transcript, metrics-projection and the orchestration-body split.

This change's own row is **measured, not predicted**: guardrails line count before/after,
`this.runnerMinutes` 6 → 5, r7 `guardrails.service.ts` 9 → 8, 0 forwardRef cycle edges
removed — filled in by the integration track on the integrated tree under an explicit
single-writer discipline (§0 note at `:7`-`:8`: the research track left this row's five cells
blank; task 5.9 measured and appended them). Every predicted cell names the command that
would confirm or refute it, and §9 keeps the register of predictions.

The diagnostics entry records **two measured floors, never one ceiling** — 8 → 4 while legacy
is alive, 8 → 2 after legacy retires — with the explicit discipline note at `:199`
(「两个地板，不是一个天花板…给一个数字会让下一位作者把它当承诺」), and states 8 → 0 is
unreachable without modifying the requirement pinning the bus as the eleventh constructor
parameter, because `:654`/`:657` are the ninth and tenth. Nothing is carried as an
unqualified "burns to zero". §3.1 is the root with precondition **none**; §3.2 names the
`:731`/`:732` pass-through edge; §3.3 and §3.4 each say **none** explicitly so their position
is visibly a sequencing choice; §3.5 names what it waits on (N1+N2+N3+N4). §3.2 recommends
inverting the write gate into an injected no-op recorder paired with extracting the two
private wrappers (rather than extracting a service) with its evidence; §3.3 records that
transcript is not a file move (token provided-but-not-exported, a controller importing back
in, path-keyed r7 entries that re-key rather than shrink, and an undeclared new directory
being a hard gate failure). §4 states the acceptance arithmetic in the open — conservative
and aggressive accounting rules named, 1,045 lines removable at most, 3,086 residual — and
§5 records that the numeric target has been replaced by structural criteria, each naming its
gate and whether it exists today. Where position rests on a product decision rather than a
measurement, §7 says so ("排序理由：为什么 legacy 先走（诚实版）") rather than presenting the
decision as a finding.

### `guardrails/guardrails-publishes-domain-events-without-changing-lifecycle-behavior` (MODIFIED) — **MET**

The delta this change adds is **form (3), the directly-read single owner**, and all five of
its preconditions are established by measurement rather than assertion on this tree:

1. **The removed call is a read** — `return this.runnerMinutes.intervals();` writes no row, publishes no event, emits no metric, mutates nothing, and the orchestrator does not branch on it (it was a one-line forwarder with no other caller inside guardrails).
2. **The state has exactly one owner after the move** — one DI provider under `RUNNER_MINUTES_PORT`; the only other `new RunnerMinutesLedger(` outside `runner-metrics/` constructs a pre-existing *local mirror class* of the same name in a mirror test, not the owner.
3. **No forwarder remains** — `runnerMinuteIntervals` returns zero matches across `apps/api/src`; the face was deleted, not renamed, wrapped, or deprecated-but-live.
4. **The consumer calls the owner directly** — `metrics.service.ts` imports the owner's `*.port.ts` and resolves `RUNNER_MINUTES_PORT`, not guardrails and not a third context's service.
5. **The proof binds the real implementation** — the characterization test feeds the real compiled `deriveRunnerMinutes` from the real owner's `intervals()` and pins the **complete** `{ available, minutes }` object, not a selected field; neither side is a double.

Publishing is offered as no part of that proof, and no write reference was removed. The bus
remains the trailing `@Optional()` 11th constructor parameter with the preceding ten
unchanged, so the write-side scenarios (`A write-side removal cannot use the third form`,
`A read the orchestrator branches on is not eligible`) are untouched negative requirements
this change does not exercise.

Verification note: the working tree contains an ad-hoc runnable probe for this requirement's
`Publishing failure does not disturb the transition` scenario
(`ground-truth-publishing-failure-does-not-disturb-transition.spec.ts`, driving the real
service through admit → onTerminal with a throwing bus). Its **evidence is sound and is why
this requirement re-traces MET**, but its **location is not** — it sits inside the frozen
guardrails directory, which is what task 6.1 re-opens. Removing it does not weaken this
verdict: the scenario is a pre-existing requirement whose behaviour this change never
touches, and the change's own diff adds no publish-path edit.

---

## Scope findings

One item in the tree has no requirement or task backing it, and it is the same item both
UNMET routes point at:

- `apps/api/src/guardrails/ground-truth-publishing-failure-does-not-disturb-transition.spec.ts` — untracked, 229 lines, runnable, added under `apps/api/src/guardrails/` during verification as a ground-truth probe (its header: *"GROUND-TRUTH CHECK (not part of the permanent suite) for the extract-runner-minutes-ledger requirement"*). No task in `tasks.md` authorizes it, and it works against two of this change's own requirements — the zero-guardrails-test-files-in-the-diff scenario and the frozen 135-`test()` / 6-`*.spec.ts` guardrails baseline. Routed to task **6.1**.

Everything else in the two commits maps cleanly onto a requirement and a task: the new
port / owner / module files, the `guardrails.service.ts` getter + backing-member rewrite,
the `metrics.service.ts` / `metrics.module.ts` / `app.module.ts` wiring, the four restated
test doubles, the `r11.json` / `r7.json` / `r11-dependency-budget.test.mjs` ratchet edits,
and the three plan-document edits (which are **in** scope by the Q4 decision — a diff with
zero plan-document edits would itself be the defect). `packages/contracts/**`,
`apps/api/prisma/**` and `docs/refactor/contexts-manifest.json` appear nowhere in the diff.

## Archive readiness

**Blocked on task 6.1 only.** There are zero spec defects and zero archive-blocking public
findings; the sidecar's `unchanged`-on-all-four-surfaces claim was executed and is true. Once
`ls apps/api/src/guardrails/*.spec.ts | wc -l` reads 6 and
`grep -ho 'test(' apps/api/src/guardrails/*.spec.ts | wc -l` reads 135, both re-opened
requirements close and this change is archivable without further work.
