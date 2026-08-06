# Verification report — `collapse-three-collaborator-groups`

Adversarial verification with three-way routing (UNMET → re-opened code task ·
SPEC-DEFECT → `design.md` Open Questions · MET → folded here). Every verdict below was
**re-traced against the working tree** in this pass — commands were re-run first-hand, not
copied from the apply log, from the commit message, or from the skeptic pass.

Tree under test **for the latest pass**: HEAD `66161c4` ("docs(openspec): finish the correction the
last one left half-done"), which carries `4f5c21c` ("refactor(guardrails): take three collaborator
groups to their measured floors"), the post-report ratchet fix `a87b179` ("fix(ratchets): restore the
projection entry the rename made invisible"), and the merge `792797e` of `main`, on top of `199074a`
(proposal) and base `c858853`. The harness-side fix `d741a71` ("fix(verify): adjudicate refutations
instead of counting them") arrived through `main` in that merge — it is not this cut's edit, and
the `no-harness-edits` assertion still passes against `main`.
Date: 2026-08-06. Working tree is clean (`git status --short` is empty).

The first pass recorded below ran on `4f5c21c` at 18 assertions. Its text is preserved rather than
rewritten — the stale numbers are marked inline with **【本轮复核】** notes — because the false-green
episode documented at the bottom of this file is the single most useful thing in it.

---

## Adjudicated tally

Three-way routing over all **6** requirements. The partition is complete: every requirement lands in
exactly one row, and the rows sum to 6.

| Route | Count | Ids |
|---|---|---|
| Re-opened as code tasks (UNMET) | **0** | — nothing appended to `tasks.md`; no `## Track: verify-reopened` section was created |
| Routed to `design.md` Open Questions (SPEC-DEFECT) | **0** | — (no `design.md` exists for this change, and none is needed) |
| Archive-blocking spec defects (public impact / false exclusion) | **0** | — the sidecar's claims were **executed**, not trusted (verifier `passed: true`, `findings: []`) |
| Adjudicated **MET** | **6** | all six, listed below |

The six MET ids, as adjudicated in this pass:

- `domain-event-bus/three-budget-entries-are-reduced-and-one-is-re-pointed-in-the-same-commit-and-by-different-rules`
- `guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor`
- `guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched`
- `resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder`
- `session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before`
- `task-provisioning-diagnostics/a-closed-diagnostics-write-gate-is-an-injected-no-op-not-a-branch-at-every-call-site`

Of those six, **0 arrived as raw-unmet** — this pass received **0 raw-unmet requirements** and
**0 mandatory public findings**, so no verdict here is a *reversal* of a skeptic's refutation. Each
was nevertheless re-traced end-to-end against the tree rather than inherited from the previous pass;
the commands re-executed for this adjudication are in the table below, and none of them was copied
from the apply log. All six
requirements are decided by the command-decidable assertion harness with **none left for LLM
judgment** — `node scripts/spec-assert.mjs collapse-three-collaborator-groups` returns
`20/20 passed; 6 requirement(s) decided without an LLM pass` on the current tree (18/18 at the time
of the first pass; the two additions, `projection-port-still-named-and-measured` and
`r7-cross-context-improved`, came in with `a87b179` and are exactly the assertions that would have
caught the false green — both were reverse-verified: renaming `CapacityProjectionPort` turns the
assertion **and** the R11 gate red together).

One **non-blocking scope finding** is recorded below (a DI-injectable diagnostics write-timeout
override that no module binds). It violates no requirement, changes no behaviour and touches no
public surface, so it is not routed to `tasks.md` and does not gate archive — it is recorded because
this report previously claimed "no scope creep found", and that claim was too strong.

The tally was not taken on trust. This pass independently re-executed the load-bearing gates and
the two discriminating tests (below), and separately ran the adversarial public-surface verifier
end-to-end, because the `resource-metrics` requirement's fourth scenario demands the surface
position be *executed rather than assumed*. All six requirements are **MET**.

---

## Gates actually executed on this tree during this pass

Every row below was re-run first-hand on `66161c4` for this adjudication.

| Gate | Command | Result |
|---|---|---|
| R12 spec assertions | `node scripts/spec-assert.mjs collapse-three-collaborator-groups` | **20/20 passed** on `66161c4` (also 20/20 on `792797e`; 18/18 on `4f5c21c`), 6 requirements decided without an LLM pass |
| R11 dependency budget | `node scripts/ratchets/r11-dependency-budget.mjs` | **exit 0** — `audit 9 / runnerMinutes 5 / provisioningDiagnosticRecorder 2 / provisioningDiagnosticWriteGate 2 / transcripts 1 / metrics-projection (CapacityProjectionPort) 2`. 【本轮复核】the `metrics-projection` entry is **present**, measuring the renamed symbol; the first pass recorded it as deleted, which is the defect `a87b179` fixed |
| R11 paired test | `node --test scripts/ratchets/r11-dependency-budget.test.mjs` | **12 pass / 0 fail** |
| R11 entry diff vs `main` | `git diff main -- scripts/ratchets/r11.json` | three entries **reduced** (4→2, 4→2, 2→1) with `symbol` byte-identical; one **re-pointed** under the SAME json key `guardrails-symbol-reference:metrics-projection` (`SemaphoreProjectionSource` → `CapacityProjectionPort`, count 2→2); `this.audit` and `this.runnerMinutes` do not appear in the diff at all, i.e. byte-identical as their scenario requires |
| Transcript ordering regression | `node --test apps/api/src/session-transcripts/transcript-capture-ordering.test.mjs` | **2 pass / 0 fail**, including the negative control (`the same assertion FAILS against a non-awaited capture`) |
| Diagnostics observer lifecycle | `node --test dist/task-provisioning-diagnostics/task-provisioning-diagnostics-observer-lifecycle.spec.js` | **12 pass / 0 fail** |
| Capacity projection pin | `node --test apps/api/src/runner-metrics/capacity-projection-pin.test.mjs` | **5 pass / 0 fail** |
| Metrics response equivalence | `node --test src/metrics/{metrics.verify,metrics-projection,task-resource}.test.mjs` | **26 pass / 0 fail** |
| Guardrails characterization | `node --test dist/guardrails/guardrails.service.spec.js` | **57 pass / 0 fail**, and `git diff --stat main -- apps/api/src/guardrails/guardrails.service.spec.ts` is **empty** — the zero-diff freeze holds |
| Adversarial public surface | `CAP_PUBLIC_SURFACE_BASE_SHA=$(git rev-parse main) node scripts/public-surface-adversarial.mjs verify collapse-three-collaborator-groups` | **`"passed": true`**, `command.exitCode: 0`, all five lanes (`sidecar`, `registry`, `restMetadata`, `mcpSdkMetadata`, `behavior`) `passed: true`, `findings: []`, `requirementIds` resolving to the guardrails + resource-metrics pair |

---

## MET requirements

**【本轮 adjudication 独立复核 · 66161c4】** The six verdicts below were re-derived from the tree in
this pass, not carried forward. What each one rested on, re-executed:

| # | Requirement | The load-bearing thing I re-checked myself |
|---|---|---|
| 1 | `domain-event-bus/...reduced-and-one-is-re-pointed...` | The `git diff main -- scripts/ratchets/r11.json` shape: three reductions with byte-identical symbols, one **re-point under the same json key**, `this.audit` / `this.runnerMinutes` absent from the diff entirely. This is the distinction the requirement exists to enforce, and the diff shows it rather than asserting it |
| 2 | `guardrails/...each-at-its-own-measured-floor` | `measureSource` on the post-change file, not a grep: recorder 2 + gate 2 = **4**, transcripts **1**, projection **2 on the new symbol**. Separately swept the whole change directory for surviving `2 → 0` / burn-down prose — `proposal.md`, `surface-impact.json` and all five spec files are clean; the only remaining hits are this report's own explicitly-historical annotations, which record the refutation rather than repeat the claim |
| 3 | `guardrails/...constructor-and-its-positional-construction-sites-are-untouched` | `node scripts/guardrails-construction-sites.mjs` → `24 17 12 20 16 9`; the 11-param constructor read directly; `guardrails.service.spec.ts` **zero diff** against `main` with all 14 `runnerMinutes` occurrences still at the exact lines the spec names (`:1375/:1380 … :3341/:3347`); and the injector-less fallback confirmed to be a real **field initializer** (`private readonly detachedRunnerMinutes: RunnerMinutesPort = createDetachedRunnerMinutes();`) with `runnerMinutes` a getter over it — which is what makes it live before the constructor body runs. Suite green at 57/57 |
| 4 | `resource-metrics/...owned-in-platform-ops...` | Ran the adversarial verifier end-to-end (the requirement demands the surface position be *executed*): `passed: true`, five lanes green, `findings: []`. Plus the r7 re-key read live (`guardrails.service.ts` 7, `metrics.service.ts` 1) and the projection port still named twice and still measured |
| 5 | `session-transcript-persistence/...without-moving-its-happens-before` | The awaited call at `guardrails.service.ts:2222` is the sole `this.transcripts` reference and it precedes both `teardownSandbox` call sites (`:2500`, `:2743`); the ordering suite's **negative control** passes, so the assertion discriminates; `guardrails.module.ts` now has `imports: []` with the `forwardRef(() => TasksModule)` edge gone; `session-transcripts` is declared in `contexts-manifest.json` in the same commit; `SessionTranscriptModule` is `@Global()` in `app.module.ts` and the three `useExisting` consumers (`tasks`, `v1`, `mcp`) resolve the same instance |
| 6 | `task-provisioning-diagnostics/...injected-no-op-not-a-branch...` | `isEnabled()` has **no match** in the orchestrator; the legacy pass-through survives verbatim (which is what pins the floor at 4, honestly recorded); the owner's lifecycle spec is green at 12/12 on the compiled tree, covering closed / absent / throwing gates |

### 1. `domain-event-bus/three-budget-entries-are-reduced-and-one-is-re-pointed-in-the-same-commit-and-by-different-rules`

**MET.** The requirement's discipline is that a *reduced* entry stays and reconciles to its own
delta while a *zeroed* entry is deleted rather than written as `count: 0`. Re-traced live:

- `node scripts/ratchets/r11-dependency-budget.mjs` exits 0. The gate is bidirectionally
  fail-closed ("every collaborator exactly at its baselined count"), so a recorded count that
  diverged from the live count in *either* direction would fail it.
- **【本轮复核 — 以下三条已被 `a87b179` 推翻并订正】** The first pass read the gate as printing exactly
  *five* collaborators with the `metrics-projection` entry deleted (`grep -c metrics-projection
  scripts/ratchets/r11.json` → 0, `COLLABORATORS.length` → 5) and treated that deletion as the
  reduce-vs-delete discipline landing correctly. It was the opposite: the coupling had been
  **renamed**, not removed, so deleting the entry stopped measuring a live edge. Live on `792797e`
  the gate prints **six** — `this.audit 9`, `this.runnerMinutes 5`, `provisioningDiagnosticRecorder 2`,
  `provisioningDiagnosticWriteGate 2`, `this.transcripts 1`, and
  `metrics-projection (CapacityProjectionPort) 2` — `COLLABORATORS.length` is back to **6**, and
  `scripts/ratchets/r11.json` carries all six keys (verified by reading the file's key list, not by
  grep). The requirement still **re-traces as MET on the corrected artifacts**: `metrics-projection`
  is the entry that is *re-pointed* (same count 2, new symbol) while the diagnostics and transcript
  entries are the ones *reduced*, and the entry-deletion rule is now stated as "the collaborator
  really left", not "its name changed".
- The paired hard-coded-expectation test (`r11-dependency-budget.test.mjs`, a single-block
  `deepEqual` plus a `COLLABORATORS` length assertion) is green at 12/12, which is the point of
  merging the three cuts into one commit: three separate cuts would have had to edit the same
  constant three times in sequence.
- Untouched entries: `this.audit` remains at 9 with its nine `guardrails.service.ts` samples and
  its adjudication prose byte-identical from the previous cut; `this.runnerMinutes` remains at 5.

### 2. `guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor`

**MET.** The requirement's substance is that each group's post-change count is **measured, not
inferred**, and that no group is reported as burned down when it is not. Re-traced live:

- Diagnostics floor is **4**, not 2: `measureSource(...)` reports
  `provisioningDiagnosticRecorder: 2` + `provisioningDiagnosticWriteGate: 2`. The two constructor
  parameters survive because both are still passed through into the legacy adapter —
  `grep -c 'this.provisioningDiagnosticWriteGate,' apps/api/src/guardrails/guardrails.service.ts`
  is non-zero, i.e. the pass-through is retained verbatim. The floor is honestly recorded as 4
  rather than dressed up as 2.
- Transcripts floor is **1**, not 0: exactly one live reference remains, and it is not incidental —
  see requirement 5.
- Metrics-projection: 【本轮复核】the *old symbol* `SemaphoreProjectionSource` reaches **0** in the
  orchestrator (confirmed live, `grep -c` → 0), but the group's true floor is **2** on the renamed
  symbol `CapacityProjectionPort`, and the R11 entry measuring it is retained rather than deleted —
  see requirement 4 and the 更正 section at the end of this file.
- No group is reported as burned down: `r11.json`'s prose records three different causes for three
  different floors rather than one headline number, and `surface-impact.json`'s `internalOnly`
  reason states `2 → 1` for transcripts explicitly noting the previous cut's `2 → 0` prediction was
  **refuted** by the call ordering. A verification pass that rubber-stamped an over-claimed
  `2 → 0` here would have been wrong; the artifact does not over-claim.
- The characterization baseline is unmoved: `ls apps/api/src/guardrails/*.spec.ts | wc -l` → **6**,
  `grep -ho 'test(' apps/api/src/guardrails/*.spec.ts | wc -l` → **135**.
- `git diff --name-only main -- .claude/workflows scripts/openspec-metadata.mjs
  scripts/public-surface-adversarial.mjs scripts/spec-assert.mjs openspec/schemas` is **empty** —
  a domain cut did not edit the harness that judges it. Note this assertion (and
  `contracts-untouched`) uses the two-dot form against the working tree; the three-dot
  `main...HEAD` form it replaced could pass vacuously on unstaged work, and that correction is
  itself inside this change's `assertions.json`.

### 3. `guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched` (MODIFIED)

**MET.** Re-traced live:

- The constructor signature is unchanged at **11 parameters** (assertion
  `constructor-signature-untouched`; independently confirmed by reading
  `apps/api/src/guardrails/guardrails.service.ts` — `moduleRef`, `creds`, `sandbox`, `config`,
  `provisionLookup`, `audit`, `prisma`, … with the bus still in tail position). No parameter was
  removed even though three collaborator groups shrank — which is exactly what makes the
  diagnostics floor 4 rather than 2.
- The recorded construction-site counts equal a live count:
  `node scripts/guardrails-construction-sites.mjs` → **`24 17 12 20 16 9`**, matching the spec's
  recorded totals. Two numbers in the spec were wrong (the blast radius of removing the transcripts
  parameter is 20 sites / 16 outside the guardrails directory / 9 files, not 14, because
  `transcripts` is the *eighth* parameter and counting from nine drops the six sites whose final
  argument is the transcripts value). They are corrected against the live count in this same cut,
  and the count is now produced by a committed script pinned by an assertion, so it cannot drift
  silently again. **This is a correction landed inside the change, not an open defect.**

### 4. `resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder`

**MET** — but only against the **restated** requirement. 【本轮复核】The verdict below was written
against the requirement's *original* wording ("no orchestrator forwarder", read as "the orchestrator
no longer names the projection"), and under that wording it was a **false green**: the orchestrator
still names the collaborator, through `CapacityProjectionPort` instead of `SemaphoreProjectionSource`
(`guardrails.service.ts` port import, and the boot-time
`.get<CapacityProjectionPort>(CAPACITY_PROJECTION_PORT).bindSource(this.semaphore)`). The full
account is in the 更正 section at the end of this file. What this cut actually delivers — and what
the requirement now says — is a **shape** change: a bare cross-context module import becomes a
legitimate port + token edge, `r7` `cross-context-import:.../guardrails.service.ts` 8 → **7** and
`cross-context-import:.../metrics.service.ts` 2 → **1** (both re-read live from `scripts/ratchets/r7.json`
in this pass). Under that restated wording it re-traces MET, and the two new assertions pin the
renamed symbol so the same rename cannot go unmeasured again.

Re-traced live:

- Ownership landed where the spec says: `apps/api/src/runner-metrics/capacity-projection.port.ts`
  and `capacity-projection.service.ts` exist, with `capacity-projection-pin.test.mjs` green at 5/5.
- The forwarding accessor is gone tree-wide: `grep -rn semaphoreProjection apps/api/src` → **no
  matches**, production code and test doubles alike.
- ~~The orchestrator no longer names the projection~~: `grep -c SemaphoreProjectionSource
  apps/api/src/guardrails/guardrails.service.ts` → **0**, counted by the same rule the budget
  counter uses (type-only imports included), so a "removed at runtime but still named in a type
  position" dodge would not pass. 【本轮复核】The grep result is real and still reproduces, but the
  **conclusion drawn from it was wrong**: the identifier hitting zero proved a rename, not a
  removal. A grep for a symbol the change itself renamed can only ever return 0. The live coupling
  is `CapacityProjectionPort` at count **2**, now measured by R11 and pinned by
  `projection-port-still-named-and-measured`.
- The metrics response is unchanged for the same state: the metrics suites
  (`metrics.verify`, `metrics-projection`, `task-resource`) are green at **26/26**, and
  `metrics.service.ts`'s diff is import rewiring only — `projectCapacity`/`buildSlotOccupancy` move
  from the guardrails import to the runner-metrics owner; the `GuardrailsService` import is dropped.
- **The public-surface position was executed, not assumed** — this pass ran the adversarial
  verifier itself rather than quoting the sidecar: `"passed": true`, `exitCode: 0`, five lanes
  green, `findings: []`.
- The transcript owner's move is declared where it lands: `publicV1` and `mcp` are declared
  **`derived`** (not `unchanged`), each selecting `tasks.transcript` / `get_transcript`, because the
  `TRANSCRIPT_STORE` binding's import path was rewritten in both `v1.module.ts` and `mcp.module.ts`.
  I confirmed the surrounding claim independently: `packages/contracts` has **zero** diff against
  `main`; no controller, route, or response schema changed; and the only other public-adjacent
  edits (`metrics.service.ts`, `metrics.module.ts`, `session-cast.controller.ts`) sit on
  console-side controllers (`@Controller()` with `metrics` / `tasks/:taskId/metrics`) that appear
  nowhere in the `/v1` module, so no additional operation needed selecting. The single
  `protocolDifferences` entry is the registry's own **pre-existing** `tasks.transcript /
  mcp-output-schema-relaxation`, transcribed because selecting the operation requires it — not a
  difference this cut introduces, and the `behavior` + `mcpSdkMetadata` lanes passing is what
  substantiates that. **No undeclared public impact and no false exclusion: nothing here is
  archive-blocking.**

### 5. `session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before`

**MET, and this is the requirement most worth being skeptical about** — a "move" that silently
converted an awaited call into a fire-and-forget would satisfy every count while breaking
capture-before-teardown. It does not. Re-traced live:

- The surviving reference is the awaited capture and nothing else:
  `apps/api/src/guardrails/guardrails.service.ts:2222` reads `await this.transcripts.capture(taskId);`
  and it is the **only** `this.transcripts` occurrence in the file (budget count 1).
- The ordering assertion **discriminates**, which is the difference between a real regression test
  and a decorative one. `node --test apps/api/src/session-transcripts/transcript-capture-ordering.test.mjs`
  → **2 pass / 0 fail**:
  - `capture completes before teardown begins, in the real orchestrator`, and
  - `the same assertion FAILS against a non-awaited capture` — the suite compiles a second,
    deliberately non-awaited build of the orchestrator next to the real one, first asserts that
    build still *calls* capture (so the run proves something about awaiting rather than about
    calling), makes capture artificially slow, and then judges **completion order, not elapsed
    time**. A wall-clock-threshold test would have been flaky; this one is not.
- Ownership moved cleanly: `apps/api/src/session-transcripts/` holds the module, port, service and
  its tests as a git-detected rename (92% similarity) out of `apps/api/src/tasks/`; the port is
  injected non-optionally with a no-op standing in, which is why the presence guard disappears and
  the floor is 1 rather than 2.
- The composition edge is gone and the graph still boots: the `guardrails → tasks` `forwardRef` is
  cut, `SessionTranscriptModule` is `@Global()`-provided from `app.module.ts`, and
  `node scripts/context-layout-check-v2.mjs` (layout v2 / r7) is green with the new directory
  entered into `docs/refactor/contexts-manifest.json` **in the same commit**.

### 6. `task-provisioning-diagnostics/a-closed-diagnostics-write-gate-is-an-injected-no-op-not-a-branch-at-every-call-site`

**MET.** Re-traced live:

- The orchestrator no longer evaluates the gate: `grep -n 'isEnabled()'
  apps/api/src/guardrails/guardrails.service.ts` → **no match**. The orchestrator can no longer
  tell an open gate from a closed one, which is the requirement's actual claim rather than merely
  "fewer lines".
- A closed, absent, or throwing gate returns the same "no observer" result the orchestrator used
  to compute for itself, an open gate still records through the same seam, and consumers reach the
  owner only through its port — all four scenarios are exercised by
  `task-provisioning-diagnostics-observer-lifecycle.spec.ts`, green at **12/12** on the compiled
  tree, including the fail-closed / timeout / continuation semantics that existed before the move.
- The two wrappers moved whole into `apps/api/src/task-provisioning-diagnostics/` behind
  `task-provisioning-diagnostics-observer-lifecycle.port.ts`, while the legacy pass-through in the
  orchestrator is retained verbatim — hence floor 4, recorded honestly.

---

## Gap finding — requirements without traceable implementation

**None.**

All independently re-verified and consistent with the codebase, the ratchet files, the assertion
harness (20/20 passing), the compiled test suites, and the discriminating negative-control tests.
Every one of the six requirements has concrete, executable, currently-passing evidence tying it to
code in the tree.

All 20 assertions pass live (20/20, up from the first pass's 18/18 — two more assertions were added,
`projection-port-still-named-and-measured` and `r7-cross-context-improved`, from the post-report fix
commits `a87b179` / `d741a71`), and all 6 requirements are command-decided. Independent spot checks
run in this pass (`node scripts/ratchets/r11-dependency-budget.mjs`; greps for `isEnabled()`,
`semaphoreProjection` and `SemaphoreProjectionSource`; `node scripts/guardrails-construction-sites.mjs`;
`node scripts/context-layout-check-v2.mjs`; the ordering and capacity-projection-pin tests; the
`contexts-manifest.json` entries; the `r7.json` re-keying) each corroborate a concrete, traceable
implementation for every one of the 6 requirements:

- `guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor`
  — floors 4 / 1 / (2, re-pointed) confirmed live via `measureSource`.
- `guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched`
  — 11-param constructor unchanged; `24 17 12 20 16 9` matches the spec's recorded totals.
- `task-provisioning-diagnostics/a-closed-diagnostics-write-gate-is-an-injected-no-op-not-a-branch-at-every-call-site`
  — `isEnabled()` is gone from the orchestrator (grep count 0); delegation to
  `this.provisioningDiagnostics` (5 sites) confirmed.
- `session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before`
  — `session-transcripts/` exists with its port; the ordering test passes 2/2 including the
  discriminating negative control.
- `resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder`
  — `runner-metrics/capacity-projection.{port,service}.ts` exist, `semaphoreProjection` /
  `SemaphoreProjectionSource` are zero tree-wide, the pin test passes 5/5, and r7 records the real
  gain (guardrails 8→7, metrics 2→1).
- `domain-event-bus/three-budget-entries-are-reduced-and-one-is-re-pointed-in-the-same-commit-and-by-different-rules`
  — `r11.json` holds exactly the 6 declared collaborators, with `metrics-projection` **re-pointed**
  (not deleted) at count 2.

No requirement lacks traceable implementation.

```json
[]
```

Files inspected (all under the repository root):

- `openspec/changes/collapse-three-collaborator-groups/specs/{domain-event-bus,guardrails,resource-metrics,session-transcript-persistence,task-provisioning-diagnostics}/spec.md`
- `apps/api/src/guardrails/guardrails.service.ts`
- `apps/api/src/task-provisioning-diagnostics/*` (owner service, write-gate port, observer-lifecycle)
- `apps/api/src/runner-metrics/capacity-projection.{port,service}.ts`
- `apps/api/src/session-transcripts/*` (moved service, port, `transcript-capture-ordering.test.mjs`)
- `scripts/ratchets/r11.json`, `scripts/ratchets/r7.json`, `scripts/ratchets/r11-dependency-budget.mjs`
- `docs/refactor/contexts-manifest.json`
- `apps/api/src/guardrails/guardrails.module.ts` (the removed `forwardRef(() => TasksModule)` edge),
  `apps/api/src/app.module.ts`, `apps/api/src/tasks/tasks.module.ts`, `apps/api/src/v1/v1.module.ts`,
  `apps/api/src/mcp/mcp.module.ts` (the three `TRANSCRIPT_STORE` / `useExisting` consumers),
  `apps/api/src/task-provisioning-diagnostics/task-provisioning-diagnostics.module.ts`
- `apps/api/src/guardrails/guardrails.service.spec.ts` (read for the zero-diff freeze and the 14
  `runnerMinutes` occurrences at their recorded lines)

## Scope finding — implementation beyond the specs

**One finding, non-blocking.** 【本轮复核】The first pass's "no scope creep found" was too strong.

### An unrequired DI-injectable write-timeout override for provisioning diagnostics

A new DI token `TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT` lets a composition override the
diagnostic write bound via `@Inject`, but **no module ever provides or binds it**:

- `apps/api/src/task-provisioning-diagnostics/task-provisioning-diagnostics-observer-lifecycle.port.ts:35-36`
  — the token declaration itself (with the `taskProvisioningDiagnosticWriteTimeoutMs(configured?)`
  override function that consumes it just below, at `:44-46`).
- `apps/api/src/task-provisioning-diagnostics/task-provisioning-diagnostics-observer-lifecycle.service.ts:36-37`
  — the corresponding unbound `@Optional() @Inject(TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT)
  writeTimeoutMs?: number` constructor parameter (imported at `:12`), which is a **third**
  constructor argument added with no requirement asking for a new configuration seam.

Verified in this pass: a tree-wide grep for the token (word-boundary, so the unrelated
`..._TIMEOUT_MS` constant is excluded) returns **exactly those two files** — a definition and a
consumer, and no provider anywhere. A grep restricted to `--include='*.module.ts'` across
`apps/api/src` returns **zero** matches, so the token is bound by no module at all; the module that
does wire this owner (`task-provisioning-diagnostics.module.ts`) binds the recorder, the write gate
and `TASK_PROVISIONING_DIAGNOSTICS_OBSERVER_LIFECYCLE` → `useExisting`, and never the timeout. No
test exercises it through DI either — the owner's spec only asserts the plain
`TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT_MS` constant (`:367`, `:371`).

No requirement in `specs/task-provisioning-diagnostics/spec.md` or `specs/guardrails/spec.md` asks
for a new configuration seam. The pre-move code configured this bound only through the
orchestrator's plain `config.diagnosticWriteTimeoutMs` field, and that path is **unchanged** and
still live: `guardrails.service.ts:815-836` computes `this.diagnosticWriteTimeoutMs` exactly as
`main` did and hands it to the owner positionally as `writeTimeoutMs`. The DI override is therefore
new, unused surface introduced during the relocation rather than a preserved behaviour.

**Why it is recorded and not routed:**

- It violates no requirement. The spec's "consumers reach the owner only through its port" scenario
  is satisfied — the token lives in the `*.port.ts` file, not the `*.service.ts`.
- It changes no behaviour. `@Optional()` on an unbound token resolves to `undefined`, and
  `taskProvisioningDiagnosticWriteTimeoutMs(undefined)` returns the same 2000 ms default the
  pre-move code used; the spec-configured bound that the requirement actually cares about travels
  the positional path, not this one.
- It touches no public surface (`internalOnly` is already declared `changed`).

So it is neither an UNMET code task nor an archive-blocking sidecar defect. Recommended follow-up
(a separate, one-line cut): drop the token and the third constructor parameter unless a composition
is about to bind it — a configuration seam with no binder is exactly the kind of dead surface this
phase's ratchets exist to keep out.

### Everything else re-traces inside scope

The full implementation diff — commits **`4f5c21c`, `a87b179`, `66161c4`** — was reviewed against
all six requirements across the five spec files, and against the change's own `tasks.md` /
`proposal.md`. Every changed production file was traced to a specific requirement/scenario
(`guardrails.service.ts`, the new `task-provisioning-diagnostics/`, `session-transcripts/`,
`runner-metrics/capacity-projection.*`, and every module wiring change). Only one implemented
behavior has no requirement backing it — the DI seam above, which is the same gap this change's own
report already self-flagged as non-blocking scope creep, and which I re-verified independently
against the current tree rather than inheriting. All 38 changed files were inspected hunk-by-hunk:

- `apps/api/src/guardrails/guardrails.service.ts` (all 16 hunks) — diagnostics wrapper removal,
  non-optional transcript port, projection accessor deletion, `bindSource()` boot wiring: each maps
  to a MODIFIED/ADDED requirement in `guardrails/spec.md`.
- New `task-provisioning-diagnostics-observer-lifecycle.{port,service,spec}.ts` — matches
  `task-provisioning-diagnostics/spec.md`'s "closed gate is an injected no-op" requirement exactly,
  including the fail-closed / timeout / continuation semantics that were already present pre-move.
- `session-transcripts/*` (module / port / service / ordering test) — a clean git-detected rename
  (92% similarity) from `tasks/session-transcript.service.ts`, matching
  `session-transcript-persistence/spec.md`'s happens-before and non-optional-injection
  requirements; the new ordering test directly implements the two required scenarios.
- `runner-metrics/capacity-projection.{port,service}.ts` + pin test — matches
  `resource-metrics/spec.md`'s "owned in platform-ops, no forwarder" requirement, including the
  "no logging / persistence / timers not already present" constraint.
- `scripts/ratchets/r7.json`, `r11.json`, `r11-dependency-budget.{mjs,test.mjs}`,
  `scripts/guardrails-construction-sites.mjs` — match `domain-event-bus/spec.md`'s
  reduce-vs-delete discipline and the guardrails MODIFIED requirement's construction-site recount.
- `metrics.module.ts`, `metrics.service.ts`, `v1.module.ts`, `mcp.module.ts`, `app.module.ts`,
  `tasks.module.ts`, `session-cast.controller.ts`, `contexts-manifest.json`, `surface-impact.json`,
  `assertions.json` — all consumption-side rewiring and public-surface bookkeeping required by the
  move, with no unrelated behavior touched.

The one item that could look like housekeeping outside the stated scope — fixing two
`assertions.json` checks that diffed `main...HEAD` instead of the working tree — is a
self-verification-config fix inside the change's own `assertions.json`, not a harness/tooling edit
(the `no-harness-edits` assertion independently confirms `.claude/workflows`,
`scripts/openspec-metadata.mjs`, `scripts/public-surface-adversarial.mjs`, `scripts/spec-assert.mjs`
and `openspec/schemas` are all untouched against `main`), and it is tied to the `guardrails`
requirement it verifies.

Apart from the DI seam above, no production behavior, file, or test was found that isn't traceable
to a specific requirement/scenario in the specs.

```json
[
  "DI-injectable override token TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT lets a composition override the diagnostics write bound via @Inject, but no module ever provides/binds it — apps/api/src/task-provisioning-diagnostics/task-provisioning-diagnostics-observer-lifecycle.port.ts:35-36",
  "Corresponding unbound @Optional() constructor parameter consuming that dead token, adding a third constructor arg with no requirement asking for a new configuration seam — apps/api/src/task-provisioning-diagnostics/task-provisioning-diagnostics-observer-lifecycle.service.ts:36-37"
]
```

---

## Archive readiness

Nothing routed to `tasks.md` and nothing routed to `design.md` Open Questions. No archive-blocking
spec defect: the `surface-impact.json` sidecar's claims were executed rather than trusted —
`CAP_PUBLIC_SURFACE_BASE_SHA=$(git rev-parse main) node scripts/public-surface-adversarial.mjs verify
collapse-three-collaborator-groups` was **re-run on `66161c4` in this pass** and returned
`"passed": true`, `command.exitCode: 0`, all five lanes (`sidecar`, `registry`, `restMetadata`,
`mcpSdkMetadata`, `behavior`) `passed: true`, `findings: []`, with `tasks.transcript` /
`get_transcript` selected as declared. There is therefore **no undeclared public impact and no false
protocol exclusion** — the two conditions that would make the sidecar claim false and hold the
archive. The single scope finding is internal-only, behaviour-neutral
and violates no requirement, so it does not gate archive. **This change is verification-clean for
archive.**

---

## 更正：本报告上方的 `resource-metrics` MET 判定曾是**假绿**

这一节由人工在报告写出后追加，记录一次**验证器判绿而缺陷真实存在**的事件。保留上方原判定不删，
因为「判错过什么」本身是这套流程最该留档的东西。

**当时的事实**：`correctness` 透镜给出了 refuted，并附了 file:line 证据——编排器仍点名投影协作者，
只是标识符从 `SemaphoreProjectionSource` 换成了 `CapacityProjectionPort`
（`guardrails.service.ts:109-111` 的 port import，`:912-915` 的
`.get<CapacityProjectionPort>(CAPACITY_PROJECTION_PORT).bindSource(this.semaphore)`）。
该反驳经人工独立复核**属实**。

**它为什么被判绿**：非公开面需求的存活规则是多数决——`refutedCount < ceil(total/2)`。
本轮 2 透镜 + 1 dynamic = 3 票，1 票反驳 `1 < 2` 即存活。一条**举出了 file:line 的反驳**
被两条「我找了但没找到」压过。该规则先于本轮的透镜削减（5 → 2）就存在：5 透镜时 1/6 反驳
同样 `1 < 3`。但削减确实**降低了第二个独立反驳者凑够票数的概率**。

**为什么 20 条断言一条都没拦住**：R11 的 `metrics-projection` 条目当时被按「归零即删条目」删除了，
于是闸门不再量它；而断言只 grep 旧标识符，旧标识符确实归零。**耦合仍在、却无人测量——
比改动前更糟**。这是「假燃尽」的镜像：改名让计数消失，删条目让测量消失。

**已做的修复**（都在 apply 之后、归档之前）：
1. R11 条目**恢复**并改测新符号 `CapacityProjectionPort`，count 2（与旧符号的 2 相同——耦合一处未减）；
   `COLLABORATORS` 回到 6 项。条目删除的前提改述为「协作者真的走了」，不是「它的名字变了」。
2. `resource-metrics` 需求改述：本刀交付的是**形态**变化（裸 module import → port + token 的合法跨上下文形态，
   r7 guardrails 8→7、metrics 2→1，这部分是真收益），**不是**「不再点名」。
   根因写明：容量状态（semaphore）仍在编排器里，所有者拥有不了它，所以编排器在 boot 时把它推过去。
3. 新增两条断言并做过**反向验证**：把 `CapacityProjectionPort` 改名会让断言与 R11 闸门**同时判红**。

**留给工具链的缺口（本刀不改 harness，按规矩另开 change）**：举证型反驳不应被「没找到」型投票压过。
「我找到了 file:line」与「我看了没发现」不是对称的证据。建议把存活规则改为：任何一条
**引用了具体文件行且经复核成立**的反驳即判 unmet，而不是参与多数决。
