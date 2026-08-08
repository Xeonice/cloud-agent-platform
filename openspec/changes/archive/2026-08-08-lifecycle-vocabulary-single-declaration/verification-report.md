# Verification Report — lifecycle-vocabulary-single-declaration

Adjudicated against the **working tree** (`git status` shows the change fully applied and uncommitted,
23 modified files + 1 rename). Every figure below was re-measured during this pass rather than copied
from the change's own artifacts; where a re-measurement disagreed with the artifacts it is said so.

## Verdict tally

| # | Capability / requirement | Verdict |
|---|---|---|
| 1 | `task-lifecycle-vocabulary/the-terminal-status-vocabulary-has-exactly-one-canonical-declaration` | MET (re-traced; mutation-proven — see §Re-adjudication) |
| 2 | `task-lifecycle-vocabulary/restatements-of-the-terminal-vocabulary-are-counted-per-site-and-the-convention-s-false-positives-are-named` | MET (re-traced; the self-contradicting clause is gone from the delta — see §Re-adjudication) |
| 3 | `task-lifecycle-vocabulary/the-admission-transition-subset-is-declared-once-and-consumed-not-restated` | MET |
| 4 | `task-lifecycle-vocabulary/the-test-guarding-the-lifecycle-vocabulary-fails-when-the-vocabulary-changes` | MET (mutation-proven) |
| 5 | `task-lifecycle-vocabulary/migration-discipline-is-defined-in-writing-before-it-is-enforced` | MET |
| 6 | `context-layout-report/the-prisma-placement-check-exempts-di-composition-declared-and-narrow` | MET |
| 7 | `context-layout-report/the-domain-layer-is-nameable-by-a-declared-suffix-and-naming-it-shrinks-the-unclassified-class` | MET |
| 8 | `context-layout-report/a-layout-v2-script-performs-three-check-classes-from-the-contexts-manifest` (MODIFIED) | MET |

**8 MET / 0 reopened / 0 spec defect.** No blocking spec defect: the public-surface sidecar's claims
were re-checked and hold (see §Public surface).

The three-way routing pass adjudicated independently and reached the same tally: **0 routed to
verify-reopened tasks, 0 routed to design.md Open Questions, 0 blocking spec defects**, with rows 1 and
2 confirmed as reclassified-MET. Its own evidence — including six co-occurrence sites this report had
not previously named, all six adjudicated as non-carriers — is in §Routing pass.

---

## Re-adjudication — why rows 1 and 2 moved to MET

⚠ **This section supersedes an earlier state of this same report**, which recorded row 1 as
`UNMET → verify-reopened` and row 2 as `SPEC-DEFECT → design.md Open Questions`. Both routings were
correct **when they were written** and both were then acted on: the earlier report was adjudicated
against a tree of 22 changed paths, and the tree now carries 24. The two extra paths are exactly the
two files the reopened task named. Rather than delete the history, the refutation and its remedy are
both kept, because "the skeptic was right and then the tree changed" is a different record from "the
skeptic was wrong".

The routing pass re-traced both **against the code, not against this report**, and neither survives as
a defect. The evidence is below and is reproducible.

### Row 1 — the canonical declaration, re-traced

The refutation was that two carriers of the terminal set survived in test files, and that the
assertion certifying the requirement returned `1` anyway because it was blind to both shapes. Both
halves are now closed **in the tree**:

- `apps/api/src/tasks/tasks-durable-admission-crash-matrix.spec.ts` — the `function
  isTerminalTaskStatus(status: TaskStatus): boolean` four-literal equality chain at `:782` is deleted;
  the call site at `:381` now reads `isTerminal(task.status)`, imported from
  `@/task-lifecycle/task-lifecycle.domain` at `:4`.
- `apps/web/e2e/scheduled-tasks/scheduled-tasks.spec.ts` — the double-quoted
  `new Set<TaskWire["status"]>([…four literals…])` under the canonical's own name is gone; the Set is
  now constructed from `CANONICAL_TERMINAL_TASK_STATUSES` imported from `@cap-console/contracts`, with
  a comment recording why it is derived rather than copied.
- `assertions.json#one-canonical-terminal-declaration` was widened to scan by **shape** — array/`Set`
  literals whose elements are exactly the four, plus equality chains covering exactly those four —
  across `.ts` / `.tsx` / `.mjs` under `apps/`, `packages/`, `scripts/`, tests included, in **both**
  quote styles, keyed on no symbol name. The two legitimate test-input forms are excluded by FORM
  (the iterand of `for (… of […])`, and `in: […]` in an expected-query fixture), and object-literal
  bodies are skipped so a `{key: …}` shape cannot masquerade as a set.

**Dynamically refuted rather than read.** The widened scan returns **1** on the current tree. Then each
of the two shapes that previously escaped it was re-injected as a scratch file and the scan re-run:

```
current tree                                                    → 1   (the canonical only)
+ apps/api/src/__mutant_a.spec.ts   (function equality chain, single quotes) → 2
+ apps/web/e2e/__mutant_b.spec.ts   (double-quoted Set literal, apps/web)    → 2
both mutants removed                                            → 1
```

So the assertion now fails for the exact reason it exists, and the "No copy of the set survives in a
test either" scenario is true by construction rather than by the check's blindness. `git status` is
back to 24 paths with no scratch file left behind.

The other three scenarios re-trace directly: the sole declaration is
`packages/contracts/src/task.ts:42`; `task-lifecycle.domain.ts` re-exports nothing under the old name
(`no-forwarding-alias-for-terminal-set` passes, and the module's header comment states the omission was
deliberate); and `isTerminal` at `:65` is `(status: TaskStatus): status is TerminalTaskStatus`, so
consumers narrow instead of declaring their own predicate.

**Two residuals, named so nobody "fixes" them, and neither defeats the scenario.** Both were found by
the same shape scan and both fall outside the requirement's own definition of a carrier ("an array or
`Set` literal whose elements are exactly the four terminal statuses, or an equality chain covering
exactly those four"):

- `apps/api/src/guardrails/guardrails-durable-launch-decision.spec.ts:382` spells the four literals as
  a **parameter type union** on a test factory. A type union is erased at runtime and cannot decide
  terminality for anything; it is an annotation on a fixture's input, not a second answer to "is this
  status terminal".
- `apps/api/prisma/task-admission-migration.test.mjs:996` carries the four literals inside a raw SQL
  `IN (…)` inside a `$queryRawUnsafe` template. This is the SQL analogue of the `in: […]` expected-query
  form the requirement excludes by FORM: deriving it from the canonical set would make the query the
  test pins share a source with the query the service builds, and an assertion whose two sides move
  together has stopped asserting anything.

Neither is routed. They are recorded here so a later shape-scan run that widens to type unions or to
SQL strings knows these two were seen and adjudicated, not missed.

### Row 2 — the restatement-count requirement, re-traced

The defect was real and specific: the requirement's second scenario ended `and the gate reports it`,
asserting an enforcement mechanism that does not exist anywhere in `scripts/`, inside a requirement
whose subject is a *measurement convention*. The change's own proposal had already adjudicated that it
builds no new gate.

**That clause is no longer in the delta.** `specs/task-lifecycle-vocabulary/spec.md:153-168` now reads
"…and the count is re-measured under the convention this requirement states → **THEN** it reads above
the recorded figure", followed by a ⚠ paragraph that records the reversal in full: what the scenario
used to say, the three facts that made it false (`grep -rn agent_failed_to_start scripts/` returns
zero; layout v2 reports four classes and none is a site count; the only counter is this change's
one-shot `assertions.json`), and why building the gate is a legitimate but separate change. That is
option (b) of the three the design's Open Question put to the next author, taken explicitly rather than
by silence — which is what that Open Question asked for.

All four scenarios then re-trace as true, each measured rather than argued:

```
site count under the stated convention                          → 5   (recorded: 5; pre-change: 15)
… with one synthetic four-literal array appended to a
  production file (audit-mapping.ts), then reverted             → 6   ← scenario 2, mutation-proven
case 'awaiting_input' in audit-mapping.ts                       → 1   ┐ scenario 3: both total
case 'task.awaiting_input' in v1-events.controller.ts           → 1   ┘ mappings still exhaustive
node scripts/context-layout-check-v2.mjs                        → 129 / 2 / 56 / 128, exit 0
                                                                      ← scenario 4: no class rose
```

The requirement now claims exactly what is true — a reproducible convention, not an automatic check —
so there is nothing left to route. The design's Open Question is annotated with the resolution rather
than deleted, so the reasoning survives for whoever later decides to build the gate after all.

### Full assertion set, re-run at routing time

All 24 assertions in `assertions.json` were executed end to end against the current tree:
**24 pass / 0 fail**, including the widened `one-canonical-terminal-declaration`. Compilation was
re-checked too, because the post-report fixes touched two packages and the earlier report predates
them: `apps/api` `tsc --noEmit` → clean, `apps/web` `tsc --noEmit` (its tsconfig includes `e2e/**/*.ts`,
so the Playwright suite's new contracts import is covered) → clean. The three suites the fixes touched
run green: `tasks-durable-admission-crash-matrix` 9/9, `task-lifecycle.test.mjs` 10/10,
`startup-recovery.test.mjs` 18/18, `guardrails-exit-roundtrip.test.mjs` 1/1.

---

## MET requirements, re-traced

### 3. The admission transition subset is declared once and consumed, not restated

One exported declaration exists — `ADMISSION_OWNED_TRANSITIONS` in
`apps/api/src/task-lifecycle/task-lifecycle.domain.ts:97`, an `as const satisfies
Partial<Record<TaskStatus, readonly TaskStatus[]>>` table — with `AdmissionTargetStatus` (`:103`),
`AdmissionSourceStatus` (`:106`), `AdmissionEndpointStatus` (`:117`) and `isAdmissionOwnedTransition`
(`:122`) all projected from it. Every production type position now derives:

- `tasks.service.ts:180` (`expectedStatus: AdmissionEndpointStatus`), `:2298`, `:2314`, `:2330`,
  `:2384`, and the prose comment replaced by a live call at `:2434`
- `task-operations.port.ts:46`, `:58`, `:97`, `:103`, `:109`
- `admission-coordination/task-admission.types.ts:309`
- `task-admission.worker.ts:1124`

The two `Extract<TaskStatus, 'pending' | 'queued' | 'running'>` restatements the requirement names are
gone; a repository-wide grep for `Extract<TaskStatus` now returns one hit, and it is in a test (see the
gap below).

**Scenario "The existing consumer is untouched" — MET.** The worker diff is 11 changed lines and none
of them touch the delegation: `canTransition(this.current.status, status)` at `:1134` is byte-identical
to its pre-change form. What changed is the import path (forced by the `.domain.ts` rename) and the
`beginTransition` parameter type, which moved from a restatement to the derived
`AdmissionTargetStatus`. The requirement forbids *moving a correct consumer*; deriving a type it was
restating is the requirement's own instruction, not churn.

**The one residual restatement is a REQUIRED exemption, not a gap — and this was checked rather than
taken on trust.** `apps/api/src/guardrails/guardrails.service.spec.ts:56` still spells
`next: Extract<TaskStatus, 'queued' | 'running'>`, while its sibling
`guardrails-domain-event-publishing.spec.ts:115` was converted to `AdmissionTargetStatus`. That
asymmetry looks like an oversight and is not: task 1.6 names it as a deliberate exemption with its
reason, and the reason holds up against the live specs. `openspec/specs/runner-minutes-accounting/spec.md:11`
states that `guardrails.service.spec.ts` "is frozen at zero diff by the guardrails capability", and
`openspec/specs/guardrails/spec.md` pins reflective assertion identifiers in that file by position
(`:774`, `:802`, `:814`, `:829`, `:1081`, `:1111`). Adding an import there would shift them and falsify
requirements this change never touches. `git status` confirms the file is untouched. Deriving that one
position would have been the *wrong* outcome — the requirement's own instruction is "derive, or be
named as a deliberate exemption with the reason", and this is the second branch, correctly taken.

### 4. The test guarding the lifecycle vocabulary fails when the vocabulary changes

`apps/api/src/tasks/task-lifecycle.test.mjs` no longer carries an adjacency table. It builds a
`createRequire` and pulls `ALLOWED_TRANSITIONS`, `ADMISSION_OWNED_TRANSITIONS`, `canTransition`,
`isAdmissionOwnedTransition` and `isTerminal` out of `dist/task-lifecycle/task-lifecycle.domain.js`,
and imports `TERMINAL_TASK_STATUSES` from `@cap-console/contracts` — the same `dist/`-reaching shape
the sibling `.mjs` suites use.

**Dynamically refuted rather than read.** Running it as-is: **10/10 pass**. Then the real compiled
table was mutated — the `awaiting_input -> running` edge deleted from
`dist/task-lifecycle/task-lifecycle.domain.js` — and re-run: **9 pass / 1 fail**. The module was then
restored. The scenario "Changing the real transition table breaks the test" is therefore proven by
construction, not by inspection; the pre-change file would have stayed green through the same mutation.

The requirement's escape hatch (retire instead of wire, but only with a recorded redundancy
measurement) was not taken — the test was wired, which is the branch that needs no measurement.

### 5. Migration discipline is defined in writing before it is enforced

`docs/refactor/04-rules-registry.md` §E now carries the definition at `:85-88`: DDL must be additive
(no `DROP COLUMN`, no `DROP TABLE`, no `SET NOT NULL` on an existing column), DML permitted provided
the migration declares its irreversibility in the file itself. The loose reading and the reason for it
are both on the record.

`openspec/schemas/spec-driven/templates/proposal.md` gained the per-change clause under `## Impact`,
and it states plainly that "answering it is the only enforcement this rule has: both CI compatibility
jobs it names are non-required today". That honesty is what the requirement's own ⚠ demands — the
requirement is not to be read as claiming migration compatibility is enforced, and the artifacts do not
claim it.

### 6. The Prisma-placement check exempts DI composition, declared and narrow

`docs/refactor/contexts-manifest.json` declares `prismaPlacement.exemptComposition: true` plus
`exemptCompositionWhy` (the D4 adjudication, in full, including the "keyed on the importing file's
classification" narrowness clause). `scripts/context-layout-check-v2.mjs` honours it by reusing the
`isComposition` predicate the cross-context rule already computes in the same loop — not a second
predicate — so the two exemptions cannot drift apart.

**Measured, not argued.** `node scripts/context-layout-check-v2.mjs` over 287 files under
`apps/api/src`:

```
cross-context-import: 129
layer-direction: 2
prisma-outside-store: 56
unclassified-file: 128
context-layout-v2: every class within its committed baseline
```

`prisma-outside-store` reads **56**, exactly the 59 → 56 the spec records, and the three retired
entries are exactly `guardrails.module.ts`, `sandbox.module.ts`, `runtime-models.module.ts` — visible
as the three deletions in `scripts/ratchets/r7.json`. The "non-composition file gets no cover" and
"exemption lives in the manifest, not the script" scenarios are covered by the script's own self-tests:
`node --test scripts/context-layout-check-v2.test.mjs` → **31/31 pass**.

### 7. The domain layer is nameable by a declared suffix

The manifest's `layers.fileClassification.rules` now carries
`{ "suffix": ".domain.ts", "layer": "domain", "why": … }` beside the pre-existing `.port.ts` row, and
the `why` records why the rule form was forced (the interpreter's `probe.endsWith(rule.suffix)`) and
what the degradation costs later cuts. `task-lifecycle.ts` was renamed to `task-lifecycle.domain.ts`
(git sees it as `RM`, so the history is preserved).

**Measured.** `unclassified-file` reads **128**, one lower than the recorded 129, while
`cross-context-import` holds at 129 and `layer-direction` at 2 — so the reduction is a
reclassification and not a trade, which is the scenario's actual claim. The retired baseline entry
`unclassified-file:apps/api/src/task-lifecycle/task-lifecycle.ts` is deleted from `r7.json` in the same
working tree, and the comparator (which fails a measurement below its baseline exactly as it fails one
above) reports every class within baseline.

`pnpm test:dependency-budget`'s script was run directly: `9 / 4 / 2 / 2 / 1 / 2` — "every collaborator
exactly at its baselined count". The `r11.json` diff is samples-only line-number refresh, which the
comparator treats as documentation.

### 8. MODIFIED — A layout v2 script performs three check classes from the contexts manifest

The MODIFY was the right call and the artifacts' own reversal is worth preserving: adding the
composition exemption made the previous third scenario ("not a `*.store.ts` and not covered by a
shared-kernel exemption → must be reported") **false about the tree**, because a `*.module.ts` DI
factory satisfies its antecedent and is nonetheless not reported. Leaving the requirement alone would
have shipped two live requirements contradicting each other. All three scenarios are carried through;
only the third's exemption clause changed, from "the shared-kernel exemptions" to "any exemption the
manifest declares". The live spec target `openspec/specs/context-layout-report/` exists to receive it.

The three check classes still report — the run above shows all four finding classes emitted (the
script's fourth, `unclassified-file`, is outside this requirement's three).

---

## Public surface

`surface-impact.json` declares `publicV1 / mcp / openapi / apiPlayground` as **derived with empty
operationIds** and `internalOnly: changed`. Re-checked and correct:

- The only `packages/contracts` edit is `packages/contracts/src/task.ts` adding
  `export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number]` at `:60`. It is a **type
  alias**, erased at runtime; `TaskStatusSchema`, `TERMINAL_TASK_STATUSES` members and every zod schema
  are untouched, so `runtimeWireBehavior: unchanged` is true.
- `derived` rather than `unchanged` is the right status precisely because
  `scripts/public-surface-files.mjs` classes all of `packages/contracts/src/**` as contracts — the
  sidecar cites the prior occasion this repository was caught declaring `unchanged` there. Empty
  `operationIds` is accurate, not lazy: no operation's schema moved.
- The 8 `protocolDifferences` entries are transcribed verbatim from the operation registry because
  `selectsAllExisting` forces the full list; none is a **false exclusion** invented by this change.

No undeclared public impact and no false protocol exclusion → **nothing routed to
blockingSpecDefects**.

---

## Gap analysis (no requirement is a total gap)

All 8 requirements across both spec files have concrete, traceable implementation:

- Terminal vocabulary canonical declaration → `packages/contracts/src/task.ts` (`TerminalTaskStatus`
  added) + `task-lifecycle.domain.ts` (second declaration deleted, `isTerminal` now a type guard
  consuming `TERMINAL_TASK_STATUSES`) + `startup-recovery.test.mjs` (test copy replaced with import)
- Per-site restatement reduction → `guardrails.service.ts`, `tasks.service.ts`,
  `prisma-task-admission.store.ts` all derive from the canonical set/predicate
- Admission transition subset → `ADMISSION_OWNED_TRANSITIONS` in `task-lifecycle.domain.ts`, consumed
  by `tasks.service.ts`, `task-operations.port.ts`, `task-admission.worker.ts`
- Lifecycle test wired to real module → `task-lifecycle.test.mjs` rewritten to `require()` the compiled
  `dist/task-lifecycle/task-lifecycle.domain.js`
- Migration discipline definition → `docs/refactor/04-rules-registry.md` §E and
  `openspec/schemas/spec-driven/templates/proposal.md`
- Prisma-placement composition exemption → `contexts-manifest.json`
  (`exemptComposition`/`exemptCompositionWhy`) + `context-layout-check-v2.mjs` (reuses `isComposition`)
- Domain-suffix classification rule → `contexts-manifest.json` `.domain.ts` rule row + rename
  `task-lifecycle.ts` → `task-lifecycle.domain.ts`
- MODIFIED "layout v2 script performs three check classes" → same script/manifest edit, and the live
  spec target `openspec/specs/context-layout-report` exists to be modified

No requirement is a total gap: nothing here is code or documentation that was never written. The two
items that were once non-MET were **incompleteness inside an implemented requirement** (#1 — an
unfinished test-file sweep) and a **contradiction inside the requirement text** (#2 — a scenario
asserting an enforcement its own requirement disclaims). Both have since been closed in the tree and in
the delta respectively; see §Re-adjudication. The gap analysis was re-derived independently at routing
time by inspecting each cited file, not by trusting this report's earlier revision — the traceability
table above is the result of that second pass and it reproduced the first one.

### The restatement site count, re-measured independently

The recorded figure was re-derived from scratch under the requirement's stated convention (four
terminal literals in **single** quotes co-occurring in an 8-line window, non-overlapping advance,
scanning `apps/` `packages/` `scripts/`, excluding `*.spec.ts` / `*.test.ts` / `*.test.mjs`):

```
EXCL TESTS: sites = 5   files = 4
  apps/api/src/audit/audit-mapping.ts               282   (named false positive — total mapping)
  apps/api/src/task-lifecycle/task-lifecycle.domain.ts 42  (canonical — adjacency table terminal rows)
  apps/api/src/v1/v1-events.controller.ts           324   (named false positive — inverse mapping)
  packages/contracts/src/task.ts                     30, 39 (canonical — status enum + terminal set)
INCL TESTS: sites = 15  files = 12
```

**5 sites across 4 files, and they are exactly the five the spec names.** The prediction and the
measurement agree. The two total mappings were read and both still enumerate every status arm, so the
compiler-checked exhaustiveness the requirement protects is intact.

## Scope analysis (one negligible item)

Every substantive code change traces to a specific requirement/scenario, and `assertions.json`
exercises nearly all of them directly. One item is flagged for completeness rather than as a defect:

> Exported type `AdmissionSourceStatus` (`apps/api/src/task-lifecycle/task-lifecycle.domain.ts:106-107`)
> has no consumer other than `AdmissionEndpointStatus` one line below. The requirement promises "one
> exported predicate" plus "the type positions derive from it"; this is a third exported type with no
> call site of its own. It is compile-time-only (erased at runtime) and it is what makes the
> `AdmissionEndpointStatus` union readable rather than a nested indexed-access expression, so it is
> borderline whether it counts as "implemented behavior" at all. **Not routed anywhere.** It is
> `apps/api`-internal, so it is not public surface, and `internalOnly: changed` already covers it.

The routing pass re-derived this scope analysis independently — walking every modified file's diff
against the two spec files' requirements and scenarios — and reached the **same single item**:
`AdmissionSourceStatus` is the only implemented symbol with no requirement backing it. The admission
requirement promises "one exported predicate" plus "type positions [that] derive from it", not a third
standalone exported type; it exists only to keep `AdmissionEndpointStatus` one line below readable
instead of a nested indexed-access expression. Compile-time-only, erased at runtime, internal to
`apps/api`. Confirmed non-blocking, not routed.

The whole-file JSON reformatting in `docs/refactor/contexts-manifest.json` (single-line arrays becoming
multi-line) is diff noise rather than behavior, so it is deliberately absent from the scope list; the
parsed rule table and `prismaPlacement` object were read back through `require()` to confirm only the
two intended keys changed semantically.

Everything else checked and found requirement-backed:

- `packages/contracts/src/task.ts:60` `TerminalTaskStatus` — Req 1; `surface-impact.json` documents it
  explicitly as the change's one deliberate public-surface widening.
- `task-lifecycle.ts → task-lifecycle.domain.ts` rename/consolidation, `isTerminal` becoming a type
  guard — Req 1 plus its narrowing scenario.
- `ADMISSION_OWNED_TRANSITIONS`, `AdmissionTargetStatus`, `AdmissionEndpointStatus`,
  `isAdmissionOwnedTransition` and their consumption sites (`tasks.service.ts`,
  `task-operations.port.ts`, `task-admission.worker.ts`, `task-admission.types.ts`,
  `guardrails-domain-event-publishing.spec.ts`) — Req 3, including the 11-site undercount task 1.6
  documents finding.
- `guardrails.service.ts` five restatements removed — Req 2 (guardrails-derives-not-restates); the
  survivor at `:2216` is a `TERMINAL_TASK_STATUSES.find(...)` consumption, not a restatement. The
  file's frozen sibling `guardrails.service.spec.ts` is correctly left at zero diff (see Req 3).
- `prisma-task-admission.store.ts` / `.spec.ts` parameterised `IN` lists (`Prisma.join([...TERMINAL_TASK_STATUSES])`
  at `:99` and `:126`) — Req 2 (admission-store-sql track).
- `task-lifecycle.test.mjs` wired to `dist/task-lifecycle.domain.js`, `startup-recovery.test.mjs` copy
  removed — Req 4 and the REOPENED task 1.7 fix.
- `contexts-manifest.json` `.domain.ts` suffix rule + `prismaPlacement.exemptComposition` /
  `exemptCompositionWhy`, `context-layout-check-v2.mjs` reusing `isComposition`, its added self-tests,
  `r7.json` / `r11.json` baseline deletions and refreshes — both `context-layout-report` ADDED
  requirements plus the MODIFIED third.
- `04-rules-registry.md` additive-only definition, `proposal.md` template clause — Req 5.

No other file in `git status` (21 changed + the new change directory) contains code outside this
mapping. The JSON reformatting noise in `contexts-manifest.json` is cosmetic — the parsed rule table and
`prismaPlacement` object were read back through `require()` to confirm only the two intended keys
changed semantically.

---

## Routing pass — independent confirmation, and the six sites this report had not named

The three-way routing pass received **zero raw-unmet findings and zero mandatory public findings** as
input, so nothing was routed on instruction; everything below is a re-derivation from the tree rather
than an adjudication of someone else's list. The gap and scope analyses were rebuilt **from the tree
rather than from this report**, both reproduced, and the outcome is **0 verify-reopened tasks, 0 spec
defects, 0 blocking spec defects**.
The two rows that once carried a refutation (`…has-exactly-one-canonical-declaration`
and `…are-counted-per-site-and-the-convention-s-false-positives-are-named`) were re-traced end to end
and re-confirmed as MET; see §Re-adjudication for the evidence they were checked against, and below for
what the routing pass added to it.

**Gap.** All 8 requirements across both spec files have confirmed, traceable implementations in the
current working tree, consistent with this report's own conclusion that no requirement is a total gap.
Spot-checked independently at routing time, each by reading the cited symbol rather than the report's
claim about it: `TERMINAL_TASK_STATUSES` (`packages/contracts/src/task.ts:42`) and `TerminalTaskStatus`
(`:60`); `isTerminal` (`:65`), `ADMISSION_OWNED_TRANSITIONS` (`:97`) and `isAdmissionOwnedTransition`
(`:122`) in `apps/api/src/task-lifecycle/task-lifecycle.domain.ts`; consumption in `guardrails.service.ts`
(imports at `:22-29`, `isTerminal` at `:983`/`:2851`/`:3290`, `TERMINAL_TASK_STATUSES.find` at `:2216`)
and in `prisma-task-admission.store.ts` (`Prisma.join([...TERMINAL_TASK_STATUSES])` at `:99` and `:126`);
the wired `task-lifecycle.test.mjs` (`createRequire` → `dist/…/task-lifecycle.domain.js` at `:30-40`,
contracts import at `:28`); the additive-only definition at `docs/refactor/04-rules-registry.md:85-89`;
the migration clause in `openspec/schemas/spec-driven/templates/proposal.md:25-33`; and
`exemptComposition`/`exemptCompositionWhy` (`contexts-manifest.json:273-274`) plus the `.domain.ts`
suffix rule (`:85`), consumed through the shared `isComposition` predicate in
`scripts/context-layout-check-v2.mjs` — defined once at `:423` and read by the Prisma rule at `:435`,
the cross-context rule at `:463` and the layer rule at `:485`, so the two exemptions provably cannot
drift apart. `node scripts/context-layout-check-v2.mjs` was re-run and reproduced **129 / 2 / 56 / 128,
exit 0** — the same four figures §6 and §7 record. `task-lifecycle.domain.ts` was re-grepped for any
`export`ed name carrying the retired set: **zero hits**, so the no-forwarding-alias scenario holds by
measurement.

**Scope.** The full diff was walked hunk-by-hunk against both spec files. A bookkeeping correction
first, because this report states the figure twice and both statements are off by one: `git status`
shows **25 entries — 24 modified plus 1 rename**, not "23 modified + 1 rename" (§header) and not "21
changed" (§Scope analysis). Nothing follows from it except that the two figures should not be quoted
onward; the *set* of paths is the one both analyses actually walked. Every substantive change traces to
a stated requirement, with exactly **one** exception, and
it is the same one this report already self-flagged in §Scope analysis: exported type
`AdmissionSourceStatus` (`apps/api/src/task-lifecycle/task-lifecycle.domain.ts:106-107`) has no
requirement backing it — the admission requirement promises one exported predicate plus type positions
deriving from the table, not a third standalone exported type. It exists only to keep the adjacent
`AdmissionEndpointStatus` union (`:117-119`) readable instead of a nested indexed-access expression, has
no consumer of its own outside that one use, is compile-time-only (erased at runtime) and is internal to
`apps/api`. Independently re-derived, same verdict: **non-blocking, not routed.** No other implemented
behavior across the 25 changed entries lacks a requirement it maps to.

### Six co-occurrence sites this report had not previously named, each adjudicated

The routing pass re-ran the four-literal co-occurrence scan across `apps/`, `packages/` and `scripts/`
with tests included and both quote styles: **15 window hits**, matching this report's own
`INCL TESTS: sites = 15` figure. Nine were already adjudicated above (two canonical in `task.ts`, the
adjacency table, the two named total mappings, the two residuals in
`guardrails-durable-launch-decision.spec.ts` / `task-admission-migration.test.mjs`, and the e2e file now
deriving from the canonical import at `:12`/`:150-153`). **Six were not named anywhere in this report**,
so each was opened and tested against the requirement's own carrier definition — an array or `Set`
literal whose elements are exactly the four, an equality chain covering exactly those four, or a
`switch` whose case labels are exactly those four and no non-terminal status. **None is a carrier:**

| Site | Shape | Why it is not a carrier |
|---|---|---|
| `apps/api/src/tasks/tasks-startup-durable-recovery.spec.ts:315`, `:363` | four literals inside `status: { in: [...] }` in an `assert.deepEqual(args, …)` expected-query fixture | exactly the form the requirement excludes BY FORM — deriving it would make the pinned query share a source with the built one |
| `apps/api/src/v1/v1-events.controller.spec.ts:443` | `cases` array of `[eventType, status]` pairs | covers all nine arms including `pending`/`queued`/`running`/`awaiting_input`, and is the iterand of a `for (… of …)` — both excluded |
| `apps/web/src/components/session/session-view-mode.test.ts:29` | `for (const status of ["completed","failed","cancelled","agent_failed_to_start"] as const)` (double-quoted, `apps/web` house style) | the excluded iterand form verbatim: it feeds statuses into assertions, it does not decide which are terminal |
| `apps/web/src/components/session/session-view-mode.test.ts:50` | four adjacent single-status `expect(sessionTaskState("…"))` calls | four separate one-status assertions that happen to fall inside an 8-line window; no literal is bound to any name |
| `apps/web/src/routes/_app/schedules.tsx:819` | `if (status === …)` badge chain | covers `running` and `awaiting_input` too, so it is a total presentation mapping, not an equality chain over *exactly* the four |
| `packages/contracts/src/session-history.ts:202` | `switch` in `replayPresentationState` | exhaustive over all eight statuses — this IS the fix Req 1 mandates (form (iii): total mapping, not restatement) |

That the scan surfaces six sites this report had not listed and all six fall outside the carrier
definition is the stronger result: the requirement's exclusions were applied to positions the report's
author had never enumerated, and they held. Recorded here so a later widening of the shape scan knows
these six were seen and adjudicated, not missed.

---

## Commands run in this pass

Earlier pass (tree at 22 changed paths):

```
node scripts/context-layout-check-v2.mjs                              # 129 / 2 / 56 / 128, within baseline
node --test --test-force-exit scripts/context-layout-check-v2.test.mjs # 31/31 pass
node scripts/ratchets/r11-dependency-budget.mjs                        # 9/4/2/2/1/2, every collaborator at baseline
node --test apps/api/src/tasks/task-lifecycle.test.mjs                 # 10/10 pass
  … then mutate dist adjacency table, re-run                           # 9 pass / 1 fail  ← mutation proof
  … then restore dist
<site-count scan under the spec's stated convention>                   # 5 sites / 4 files (excl tests)
<shape- and quote-agnostic declaration scan>                           # 2 surviving test copies ← Req 1 UNMET then
assertions.json#one-canonical-terminal-declaration                     # returned "1" — passed while blind
```

Routing pass, after the reopened task and the delta correction landed (tree at 24 changed paths):

```
<shape scan: arrays/Sets/equality chains, both quote styles, tests included>   # 1  ← only the canonical
  + scratch apps/api/src/__mutant_a.spec.ts (function equality chain)          # 2  ← mutation proof A
  + scratch apps/web/e2e/__mutant_b.spec.ts (double-quoted Set)                # 2  ← mutation proof B
  … both scratch files removed, re-run                                         # 1
<site-count scan under the spec's stated convention>                           # 5 sites (recorded: 5)
  + one synthetic four-literal array in audit-mapping.ts, re-run               # 6  ← Req 2 scenario 2
  … reverted, re-run                                                           # 5
node scripts/context-layout-check-v2.mjs                                       # 129 / 2 / 56 / 128, exit 0
pnpm exec turbo run build --filter=@cap-console/api                            # 9/9 (cached — dist current)
apps/api  pnpm exec tsc --noEmit                                               # clean
apps/web  pnpm exec tsc --noEmit  (tsconfig includes e2e/**/*.ts)              # clean
node --test dist/tasks/tasks-durable-admission-crash-matrix.spec.js            # 9/9 pass
node --test apps/api/src/tasks/task-lifecycle.test.mjs                         # 10/10 pass
node --test apps/api/src/tasks/startup-recovery.test.mjs                       # 18/18 pass
node --test apps/api/src/guardrails/guardrails-exit-roundtrip.test.mjs         # 1/1 pass
<runner over every entry in assertions.json>                                   # 24 pass / 0 fail
```

Three-way routing pass (independent re-derivation, tree unchanged at 25 `git status` entries):

```
node scripts/context-layout-check-v2.mjs                                       # 129 / 2 / 56 / 128, exit 0
<four-literal co-occurrence scan, tests included, both quote styles>           # 15 hits (matches INCL TESTS: 15)
  … 9 already adjudicated in this report, 6 previously unnamed
  … each of the 6 opened and tested against the carrier definition             # 0 carriers ← see §Routing pass
grep TERMINAL/export in task-lifecycle.domain.ts                               # 0  ← no forwarding alias
<read-back of every symbol the gap analysis cites, in its own file>            # all 8 requirements traceable
<hunk-by-hunk walk of the 24-path diff against both spec files>                # 1 unbacked symbol: AdmissionSourceStatus
                                                                               #   (already self-flagged; non-blocking, not routed)
```
