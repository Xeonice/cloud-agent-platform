<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.
     Task ids are stable identity — the apply workflow dispatches a track by task id, so ids are
     never renumbered when the partition is corrected.

     PARTITION CORRECTED (2026-08-05) against file coupling measured live on THIS tree. All 70
     tasks are pending (zero `- [x]`), so nothing below is a resume skip.
       wave 1: 1 owner-and-port ∥ 2 characterization-proof ∥ 3 range-b-research
       wave 2: 4 ownership-move-and-ratchet            (after 1 ONLY — see below)
       wave 3: 5 gates-and-verification                (integration, serial, after all)
     No file is written by more than one of tracks 1–4. The only two-writer files are handled by
     the integration track, which is where shared-file work belongs:
       - `openspec/changes/extract-runner-minutes-ledger/research-findings.md` — created by track 3,
         APPENDED by integration task 5.9 (one parallel writer plus integration, never two in
         parallel);
       - `openspec/changes/extract-runner-minutes-ledger/tasks.md` — every track ticks its own
         boxes, and checkbox loss across merged worktrees is the known failure mode, so integration
         reconciles the ledger last rather than trusting any single worktree's copy.

     Measured while correcting this partition (evidence for the decisions, NOT a substitute for
     task 1.1's own re-measurement):
       - `guardrails.service.ts` is 4131 lines; `this.runnerMinutes` appears 6× at
         1824/2319/2917/3264/3286/3880; `runnerMinuteIntervals` has exactly 6 occurrences in
         `apps/api/src` (1 declaration + 1 production call + 4 test doubles).
       - r7 `cross-context-import:…/guardrails.service.ts` = 9, `…/metrics.service.ts` = 2, and both
         `unclassified-file:…/runner-metrics/{runner-minutes,metrics-projection}.ts` = 1.
       - `node scripts/context-layout-check-v2.mjs` and `node scripts/ratchets/r11-dependency-budget.mjs`
         both exit 0 on this tree right now, so every delta below is measured off a green baseline.
       - The shared comparator is fail-closed in BOTH directions (`scripts/ratchets/comparator.mjs`
         header: a measured count BELOW its baseline is "equally red"). The guardrails r7 entry
         therefore MUST fall 9 → 8 in the same commit as the import change. No drafted task owned
         that file, so task 4.22 was added to track 4 during this correction.
       - `metrics` and `runner-metrics` are the SAME context (platform-ops) in
         `docs/refactor/contexts-manifest.json`, which is why 4.11 can inject the port without
         moving metrics' r7 count off 2, and why the new files add no cross-context finding.
         Layer direction is judged only inside a context, and application→domain is allowed, so the
         new `.service.ts`→`.port.ts` edges add no `layer-direction` key either.
       - The layout gate governs only non-test `.ts`/`.tsx` (`context-layout-check-v2.mjs:246`), and
         apps/api's `test:src` script already globs `src/**/*.test.mjs`. The test files tracks 1 and
         2 add therefore create no new `unclassified-file` key and need no mounting edit anywhere.

     Partition decisions that are NOT free:
       - track 4 is deliberately fat. `specs/domain-event-bus` (lines 74-77) requires
         `guardrails.service.ts`, `metrics.service.ts` and
         `scripts/ratchets/r11-dependency-budget.test.mjs` to be integrated on ONE serial
         track, so the four metrics test doubles and the ratchet edits ride with them rather than
         forming parallel tracks that would race the same review surface.
       - track 4 NO LONGER depends on track 2. There is no file dependency between them — track 2
         writes one new test file track 4 never reads or edits. The spec's obligation is COMMIT
         ordering (the characterization test is "introduced by a commit that precedes the commit
         moving ownership"), and that is discharged by integration task 5.1, not by apply-time
         sequencing. Track 2's "green on the pre-move tree" (2.5) holds inside its own worktree
         whatever track 4 is doing. Track 4 does depend on track 1: it imports that track's port.
       - track 3 stays whole at 18 tasks even though 3.13-3.16 write different files. 3.13 drafts
         the replacement acceptance criteria that 3.14/3.15 then apply, and that draft belongs in
         `research-findings.md`, which track 3 owns — splitting them would put two writers on that
         artifact, the exact hazard this correction exists to remove. Track 3's length is
         documentation depth, not coupling.
       - tracks 1 and 2 both add a NEW test file under `apps/api/src/runner-metrics/`. Each track's
         header names ITS file; neither may write into the other's. That is the one latent collision
         in this change's write sets, and it is resolved by naming, not by serialization. -->

## 1. Track: owner-and-port (depends: none)

<!-- Writes (all NEW files, sole writer): apps/api/src/runner-metrics/runner-minutes-ledger.port.ts,
     apps/api/src/runner-metrics/runner-minutes-ledger.service.ts,
     apps/api/src/runner-metrics/runner-minutes.module.ts,
     apps/api/src/runner-metrics/runner-minutes-ledger.port.test.mjs — task 1.4's executable proof
     needs a home, and it must be THIS track's own file. Track 2 runs in parallel and owns
     `runner-minutes-derivation.test.mjs`; putting the factory assertion there would make one file
     have two writers in one wave. Load it from `dist/runner-metrics/` the way
     `apps/api/src/metrics/metrics.verify.test.mjs` loads dist; apps/api's `test:src` glob mounts it
     with no registration step.
     Reads only: apps/api/src/runner-metrics/runner-minutes.ts, apps/api/src/audit/audit-recorder.port.ts
     (the first-cut recorder template), docs/refactor/contexts-manifest.json.
     MUST NOT touch: the two pre-existing bare `.ts` files here — their r7 `unclassified-file`
     entries (measured live: both count 1) go stale the moment either is renamed or moved — nor
     anything under apps/api/src/guardrails/, apps/api/src/metrics/, scripts/ratchets/, docs/, or
     track 2's test file.
     Task 1.10's handoff is what unblocks track 4; track 4 READS it and never writes here. -->

<!-- Layer facts this track must not break (measured): `.port.ts` classifies as `domain`, which may
     import nothing but `domain` — importing the unclassified `runner-minutes.ts` is fine because the
     gate skips unclassified endpoints, but importing any `.service.ts` or `.store.ts` would be a new
     `layer-direction` key and 5.7 forbids new keys. `.service.ts` is `application` and may import the
     port. `.module.ts` is `composition` and is exempt. -->

- [x] 1.1 Re-measure the starting position on this tree and record it for tracks 4 and 5: `wc -l apps/api/src/guardrails/guardrails.service.ts` (expect 4131), `grep -n 'this\.runnerMinutes' apps/api/src/guardrails/guardrails.service.ts` (expect 6 at 1824/2319/2917/3264/3286/3880), and the r7 counts for `cross-context-import:apps/api/src/guardrails/guardrails.service.ts` (expect 9) and `cross-context-import:apps/api/src/metrics/metrics.service.ts` (expect 2). Do not copy these from the proposal — the proposal's numbers are themselves a measurement that may have aged.
  - requirements: ["guardrails/the-runner-minutes-read-face-is-removed-under-a-proven-owner-while-every-write-is-retained"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.2 Create `apps/api/src/runner-metrics/runner-minutes-ledger.port.ts` exporting **exactly three symbols**: the `RunnerMinutesPort` interface declaring exactly `recordStart(taskId: string): void`, `recordEnd(taskId: string): void`, `intervals(): RunningInterval[]`; the `RUNNER_MINUTES_PORT` DI token; and `createDetachedRunnerMinutes(): RunnerMinutesPort`. Model the file on `apps/api/src/audit/audit-recorder.port.ts`. Do not export or re-export `RunnerMinutesLedger`.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.3 Document `createDetachedRunnerMinutes` in the port file as the injector-less fallback and nothing else: it exists because `apps/api/src/guardrails/guardrails.service.spec.ts` is frozen at zero diff by the guardrails capability and constructs the service positionally at `:94` with no injector, then reflectively reads `internals.runnerMinutes.intervals()` at 7 assertion sites (`:1380`, `:3021`, `:3078`, `:3136`, `:3207`, `:3280`, `:3347`; the identifier appears 14 times because each site also carries a type annotation). State in the comment that its only production call site is the orchestrator's fallback backing member, and that `onModuleInit` resolves the owner into a SEPARATE member which the getter prefers — the fallback is bypassed, not replaced in place.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token", "runner-minutes-accounting/running-interval-state-has-exactly-one-owner-and-it-lives-in-platform-ops"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.4 Make the factory return a REAL ledger, never a no-op: drive the returned instance directly with one `recordStart`, then `intervals()`, then `recordEnd`, then `intervals()` again, and assert the first read shows one open interval and the second shows it closed. This is load-bearing — all 7 reflective assertions in the frozen guardrails spec assert the ABSENCE of open intervals, so a no-op fallback would satisfy every one of them vacuously while accounting nothing.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token", "runner-minutes-accounting/running-interval-state-has-exactly-one-owner-and-it-lives-in-platform-ops"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.5 Verify the port carries no task-execution vocabulary: scan the new file case-insensitively for `admission`, `fence`, `lease`, `semaphore`, `queued` and confirm zero matches. `RunningInterval` and `taskId` are the only domain nouns permitted.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.6 Create `apps/api/src/runner-metrics/runner-minutes-ledger.service.ts`: an `@Injectable()` class holding a **private** `RunnerMinutesLedger` field and delegating the three port methods to it. Export zero module-level mutable ledger instances — the instance is a private field, not a file-scope singleton.
  - requirements: ["runner-minutes-accounting/running-interval-state-has-exactly-one-owner-and-it-lives-in-platform-ops"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.7 Add nothing else to the owner: no `Logger`, no `console.`, no injected logger parameter, no persistence, no metrics emission, no timers, no retries, no error handling the ledger did not already have. Confirm by grepping the new file for `Logger` and `console.` (expect zero). The orchestrator's asserted logger-context strings depend on this.
  - requirements: ["runner-minutes-accounting/the-ownership-move-adds-no-runtime-behavior-and-no-observable-output-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.8 Create `apps/api/src/runner-metrics/runner-minutes.module.ts` providing the owner under `RUNNER_MINUTES_PORT` and exporting that token. Keep it a pure composition file — the `.module.ts` suffix is the classified composition form and carries the cross-context exemption.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.9 Confirm every file this track added carries a classified suffix (`.port.ts` / `.service.ts` / `.module.ts`) and that `apps/api/src/runner-metrics/runner-minutes.ts` and `metrics-projection.ts` are byte-identical to their pre-change form — a rename or move of either turns their `unclassified-file` r7 entries stale and the comparator red.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.10 Publish the track handoff for track 4: the exact export names and import path of the port, the token identifier, and the owner class name.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 2. Track: characterization-proof (depends: none)

<!-- Writes (NEW file, sole writer): apps/api/src/runner-metrics/runner-minutes-derivation.test.mjs.
     Reads only: apps/api/src/metrics/metrics.verify.test.mjs (for the dist-loading idiom),
     apps/api/src/metrics/runner-minutes.test.mjs (to confirm it is the WRONG landing site),
     apps/api/src/runner-metrics/runner-minutes.ts.
     HARD CONSTRAINT — this file MUST NOT import the port file track 1 creates, or anything track 1
     or track 4 adds. Integration task 5.1 commits this file ALONE and FIRST, ahead of the ownership
     move; a test importing a symbol that only exists in the second commit is red in the first one
     and cannot be "green on the pre-move tree" (2.5). Task 2.4's "through the port shape" means the
     three-method shape `RunnerMinutesLedger` ALREADY has (recordStart / recordEnd / intervals),
     driven off the compiled `dist/runner-metrics/runner-minutes` module — not the `.port.ts` file.
     MUST NOT write track 1's `runner-minutes-ledger.port.test.mjs`, and MUST NOT add any file under
     apps/api/src/guardrails/ — that directory's characterization baseline (135 test() / 6 *.spec.ts
     / 8 *.test.mjs) is pinned by the guardrails capability and a new test there self-inflicts a red
     gate.
     No mounting work exists to do: apps/api's `test:src` script already globs `src/**/*.test.mjs`,
     so task 2.6 VERIFIES discovery rather than arranging it. -->

- [x] 2.1 Read `apps/api/src/metrics/runner-minutes.test.mjs` and record why it cannot serve as the equivalence proof: it declares at `:13` that it mirrors `runner-minutes.ts` inline, so it stays green even if the real implementation moves or breaks. Record this verdict in the track handoff; do not delete or edit that file.
  - requirements: ["runner-minutes-accounting/the-derived-output-is-proven-unchanged-by-a-characterization-test-bound-to-the-real-implementation"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.2 Create `apps/api/src/runner-metrics/runner-minutes-derivation.test.mjs` loading the **compiled** `runner-minutes` module the way `apps/api/src/metrics/metrics.verify.test.mjs` already loads `dist/`. Assert nothing against a locally re-declared copy of `deriveRunnerMinutes` or of the ledger.
  - requirements: ["runner-minutes-accounting/the-derived-output-is-proven-unchanged-by-a-characterization-test-bound-to-the-real-implementation"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.3 Pin the **complete** `{ available, minutes }` result object with `assert.deepEqual` over a fixed interval fixture and an injected frozen `now`: closed intervals only, in-flight intervals only, a mix, and the empty fixture. The empty case asserts exactly `{ available: false, minutes: null }` — not a fabricated `0`.
  - requirements: ["runner-minutes-accounting/the-derived-output-is-proven-unchanged-by-a-characterization-test-bound-to-the-real-implementation"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.4 In the same file, pin the ledger's recorded semantics through the port shape so the move cannot silently alter them: a duplicate `recordStart` for an already-open task is ignored, a `recordEnd` for a task that never started is a no-op, an interval whose `endedAt` precedes its `startedAt` contributes 0 minutes rather than subtracting, and `intervals()` returns closed intervals before open ones.
  - requirements: ["runner-minutes-accounting/the-ownership-move-adds-no-runtime-behavior-and-no-observable-output-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.5 Run the new test on the **pre-move** tree (the read face at `guardrails.service.ts:3880` still present) and record it green. This is the "passes unmodified across the move" baseline; if it needs an edit after track 4 lands, the move changed behaviour and the move is what is wrong.
  - requirements: ["runner-minutes-accounting/the-derived-output-is-proven-unchanged-by-a-characterization-test-bound-to-the-real-implementation"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.6 Confirm the new file is actually discovered: run the repository test-discovery gate and `pnpm test:scripts` and check the file is reported as executed, not silently skipped. A `.test.mjs` that no runner picks up is the failure mode this repository has already been bitten by.
  - requirements: ["runner-minutes-accounting/the-derived-output-is-proven-unchanged-by-a-characterization-test-bound-to-the-real-implementation"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.7 Re-count the guardrails characterization baseline and confirm this track moved nothing: `test()` cases across `apps/api/src/guardrails/*.spec.ts` still 135 over 6 files, `.test.mjs` scripts still 8.
  - requirements: ["guardrails/test-doubles-of-the-removed-accessor-are-restated-and-every-rewrite-is-ledgered"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 3. Track: range-b-research (depends: none)

<!-- Writes (sole parallel writer of all four): openspec/changes/extract-runner-minutes-ledger/research-findings.md
     (NEW), docs/refactor-master-plan.md, docs/refactor/08-ddd-target-architecture.md,
     docs/refactor/07-baselines-and-dependencies.md. No other parallel track touches any of them.
     Reads only: guardrails.service.ts, scripts/ratchets/r11.json, docs/refactor/contexts-manifest.json,
     openspec/changes/archive/2026-08-05-adjudicate-audit-event-migration/adjudication.md.
     Pure documentation. Never write these verdicts into guardrails.service.ts comments — the
     publishing spec asserts exact whole-file occurrence counts of quoted event names — and never
     into scripts/ratchets/*.json, which is track 4's write set.
     This track fills the PREDICTED cells and the precondition graph; integration task 5.9 APPENDS
     this change's own MEASURED row, which cannot exist until track 4 has landed. Leave that row's
     five cells to 5.9 rather than pre-filling them: research-findings.md is the one artifact this
     track shares with integration, and the append is what keeps it single-writer per phase.
     Tasks 3.11/3.12 carry the Q1 decision's durable residue: the runner group's OWN event-route
     ceiling (1, not 0) and the two costs behind it. They are here rather than in track 4 because
     they are findings about a road not taken, not facts about the code this change edits.
     Tasks 3.13-3.16 land the Q4 decision (the numeric acceptance target is replaced by structural
     criteria) and stay on THIS track: 3.13's draft belongs in research-findings.md, which this track
     owns, so hiving 3.13-3.16 off would give that artifact a second writer. Live targets measured
     for them — the numeric acceptance line is `docs/refactor-master-plan.md:147`
     ("guardrails 3,806 → <2,000 行"), the ratchet promise is the same file's `:140`
     ("依赖预算 ratchet…降到 0 转禁止"), and the stale 3,806 baselines are master-plan `:20`,
     `07-baselines-and-dependencies.md:32`, `08-ddd-target-architecture.md:19`.
     Archived change directories are NEVER edited: they are immutable records and several of them
     restate the old target by design. -->

- [x] 3.1 Create `openspec/changes/extract-runner-minutes-ledger/research-findings.md` with two sections: a Mikado-style precondition graph over every remaining phase-4 node, and an outcome table whose columns are exactly the five dimensions this change actually measures — guardrails line delta, R11 count delta, r7 cross-context delta, forwardRef cycle edges affected, test files changed. The graph's decided order (user, 2026-08-05) is **legacy inline-admission retirement -> diagnostics -> transcript -> metrics-projection -> orchestration-body split**, with legacy retirement as the root node.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.2 Fill the diagnostics-group row (`provisioningDiagnosticRecorder` 4 + `provisioningDiagnosticWriteGate` 4 = 8 references, live at `:654`/`:657` declarations, `:731`/`:732` pass-through, `:2949`/`:2950`/`:3017`/`:3018` local aliases). Record **two measured floors, never one ceiling**: **8 → 4 while legacy is alive** and **8 → 2 after legacy retires**. Record that **8 → 0 is unreachable by refactoring alone**, because `:654`/`:657` are the ninth and tenth constructor parameters and the standing requirement pins the bus as the eleventh with "the preceding 10 parameters keep their existing order and types" — removing them makes that scenario literally false, so zero needs a spec MODIFY plus the 13 positional construction sites that pass those positions, 9 of which sit outside `apps/api/src/guardrails/` where spec forbids editing beyond the trailing bus argument.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.3 Record the recommended shape for the diagnostics group with its evidence: invert the write gate into an injected no-op recorder **paired with extracting the two private wrapper methods** (`tryBegin` at `:2946` and `tryResume` at `:3014`), rather than extracting a service. State the measured effect honestly: gate inversion alone takes WriteGate **4 → 2** (not 4 → 0 — the legacy pipeline consults the gate independently and the constructor parameter survives) and leaves the group at 8 → 6; pairing it with the two wrapper extractions reaches the 8 → 4 floor. Cite the measurement (`measureSource` over the simulated source) rather than asserting it.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.4 Fill the transcript-group row (`this.transcripts` 2) with precondition **none** — it is sequenced third by choice, not by dependency — and record that extracting it removes only one of the cycle's edges while no gate measures that cycle at all today. Record that extracting transcripts does **not** by itself resolve completion ordering, because NestJS gives no topological ordering guarantee across provider lifecycle hooks inside one module. This change removes **0** cycle edges.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.5 State that the transcript group's happens-before obligation must be carried by an explicit `await` on the teardown path and verified with an **ordering assertion**, not a sleep. Mark it a prediction and name the measurement that confirms or refutes it.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.6 Record that the transcript cut is **not a file move**, with the four measured traps a naive move walks into: (1) the runtime-registry token the moved service injects non-optionally is provided by the tasks module but absent from its `exports`, so a new module must re-provide it or DI resolution fails at startup rather than degrading at runtime; (2) a controller in the tasks directory imports back into the moved unit, which converts a same-directory import into a cross-context one and RAISES that file's r7 count — and the ratchet is fail-closed upward; (3) r7 entries are path-keyed, so the move re-keys rather than shrinks them and the old keys must be deleted in the same commit, since both a stale entry and a zero-count entry are red; (4) an undeclared new top-level directory is a hard `exit 1` in the layout gate, not a finding, so the manifest declaration must land in the same commit.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.7 Give every group either a precondition edge or an explicit "none" — no group may be left with an implicit blank — and label every future-group cell as a prediction naming the command or measurement that would confirm or refute it. An unfalsifiable estimate is a defect in this artifact.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.8 State the phase-4 acceptance arithmetic in the open, not in a footnote, and **name the accounting rule for every figure** — the earlier "~30 lines" estimates for diagnostics and transcript were carried through this change's own artifacts with no line numbers or command behind them, and must not be reused as if measured. Report: the current guardrails line count measured live (expect 4,131 against the plan's stated 3,806 baseline); the shortfall to the old target (4,131 − 1,999 = **≥2,132 lines**); and the span of what collaborator burn-down can remove under two explicitly named rules — the conservative union of lines that name a collaborator, and the aggressive rule of deleting every method that touches one. Give both endpoints as measured numbers with the rule attached, and state that even the aggressive endpoint leaves the file more than a thousand lines above the old target.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.9 Record the decision the gap forced and who made it: the user decided on 2026-08-05 to **replace the numeric target with structural criteria** (option b), having been shown that the two obvious candidate criteria are themselves broken. Record both rejections so they are not re-proposed: symbol references to zero is unreachable (Q1 measured the runner group's own floor at 5, and the audit group is adjudicated as 9 retained calls), and a bare "forwardRef cycle to zero" has no gate because the layout check exempts cycles formed only of composition files — an exemption restated in a live spec. This change now DOES edit the plan documents; tasks 3.13-3.16 carry that work.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.10 Record the fixed per-change overhead the remaining two groups will each pay and this one did not: both diagnostics and transcript have real `/v1` controllers, so their `surface-impact.json` will very likely need `derived` status plus transcribed `protocolDifferences`, whereas this change's `unchanged`×4 holds only because no `/v1` metrics controller exists.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.11 Record the runner group's own event-route ceiling as **1, not 0** (Q1, decided): three `recordStart` references are covered by `TaskRunStarted` and the `fenceTerminal` `recordEnd` by `TaskSettled`, but the `clearAdmissionRuntime` `recordEnd` at `guardrails.service.ts:3264` has **no lawful covering event**. Cite both the standing requirement forbidding a `TaskSettled` publish at that seam and the source comment above that method, which states the 2-call-sites-to-1-event asymmetry is deliberate and carried as a negative requirement "so a later change cannot 'fix' the asymmetry". A later change must not have to re-derive this.
  - requirements: ["domain-event-bus/the-runner-minutes-budget-entry-falls-from-6-to-5-as-a-measured-first-decrease-not-a-burn-down"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.12 Record the two costs that route carries beyond the spec conflict, both measured on this tree. First: all 14 reflective runner-minutes occurrences in `guardrails.service.spec.ts` (7 assertion sites at `:1380`, `:3021`, `:3078`, `:3136`, `:3207`, `:3280`, `:3347`) are **negative** assertions — `deepEqual(intervals(), [])` or `some(({ endedAt }) => endedAt === null) === false` — so a guardrails that stopped recording would make every one of them pass **vacuously**: the zero-diff freeze would be satisfied while the assertions silently stopped testing anything, and `:3207`'s own message ("the restored running interval is closed, while historical accounting remains") would become false. Second: subscriber-driven accounting becomes **fail-open** under the publish escape-hatch, whereas the existing retained-calls scenario keeps synchronous accounting immune to that toggle today.
  - requirements: ["domain-event-bus/the-runner-minutes-budget-entry-falls-from-6-to-5-as-a-measured-first-decrease-not-a-burn-down"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.13 Draft the replacement acceptance criteria for phase 4, each of which MUST name the command or gate that decides it and MUST be marked either measurable-today or requiring-a-named-gate-addition. Use the four measured findings: (a) every R11 collaborator entry sits at its adjudicated floor rather than zero — measurable today by `pnpm test:dependency-budget`, which is fail-closed in both directions and already runs in the required CI job; (b) the orchestrator no longer constructs cross-cutting subsystems itself — measurable by the same gate after adding class-name symbols to its collaborator table, a data change with no counting-logic change; (c) `guardrails.service.ts`'s r7 cross-context-import count falls to its adjudicated number — measurable today by `pnpm test:context-layout-v2`; (d) no `forwardRef` remains between the guardrails and tasks modules — NOT measurable today, so it must carry the concrete gate that would give it one, expressed narrowly over those two module files so it does not depend on the composition-cycle exemption.
  - requirements: ["guardrails/the-phase-4-numeric-acceptance-target-is-replaced-by-criteria-that-each-name-their-gate"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.14 Apply the replacement to `docs/refactor-master-plan.md`: replace the phase-4 acceptance line that states the numeric guardrails line target, and replace the neighbouring dependency-budget bullet that promises the ratchet "降到 0 转禁止" — that promise is the same unreachable criterion in another wording. Match the document's existing voice and formatting. Keep the line count in the plan only as reported trend data, explicitly labelled as not an acceptance criterion.
  - requirements: ["guardrails/the-phase-4-numeric-acceptance-target-is-replaced-by-criteria-that-each-name-their-gate"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.15 Apply the same replacement to `docs/refactor/08-ddd-target-architecture.md`, whose phase-4 acceptance cell restates BOTH broken criteria (the line target and R11-to-zero) in a single table cell. A revision that fixes the master plan and leaves this cell asserting the old target just relocates the contradiction.
  - requirements: ["guardrails/the-phase-4-numeric-acceptance-target-is-replaced-by-criteria-that-each-name-their-gate"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.16 Label the stale baselines as historical rather than deleting them: the "3,806 lines" figures in `docs/refactor-master-plan.md` and `docs/refactor/07-baselines-and-dependencies.md` (and the same figure in `docs/refactor/08-ddd-target-architecture.md`) were true at review time and are cited by scale-ratio estimates, so annotate each with the review-time framing and the live measurement rather than removing it. Then grep the repository to prove no non-archived document still states the numeric target as an acceptance criterion; archived change directories are immutable and are expected to keep it.
  - requirements: ["guardrails/the-phase-4-numeric-acceptance-target-is-replaced-by-criteria-that-each-name-their-gate"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.17 Record the rationale for the decided legacy-first ordering **honestly, as a product decision plus one measured effect** — never by citing the four justifications that were tested and failed (that legacy retirement zeroes diagnostics, cuts the forwardRef cycle, materially moves the line count, or unblocks transcript; all four were measured false). The supportable rationale has two parts: (1) the measured effect — retiring legacy first takes the diagnostics floor from 4 to 2, because the pass-through arguments vanish with the adapter expression rather than needing the diagnostics cut to remove them; and (2) the repository's own standing judgement, recorded in the archived legacy-isolation change, that building interfaces into a unit already slated for deletion is scaffolding for demolition, and that such work is judged by the cost remaining on retirement day. State plainly which part is measurement and which is decision.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.18 Scope the legacy-retirement node itself, since it is now first in the queue and everything else waits on it: measure the size of `apps/api/src/inline-admission/`, the number of orchestrator members its reverse port calls back into, the guardrails-side lines that leave with it, and the r7/R11 entries it removes. Record the one precondition that is genuinely NOT measurable from this tree — whether production still routes any task through the legacy path — and name the endpoint an operator must query to answer it, rather than assuming either way. Also record that this node is the only remaining one whose public-surface position depends on a product decision, because refusing admission where the capability is unproven is a behaviour change on the task-creation endpoints rather than an internal reorganization.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"

## 4. Track: ownership-move-and-ratchet (depends: owner-and-port)

<!-- Writes: apps/api/src/guardrails/guardrails.service.ts, apps/api/src/metrics/metrics.service.ts,
     apps/api/src/metrics/metrics.module.ts, apps/api/src/app.module.ts,
     apps/api/src/metrics/metrics.verify.test.mjs, apps/api/src/metrics/task-resource.test.mjs,
     apps/api/src/metrics/terminal-diagnostics-metrics.service.spec.ts,
     scripts/ratchets/r11.json, scripts/ratchets/r11-dependency-budget.test.mjs,
     scripts/ratchets/r7.json (task 4.22, added when this partition was corrected),
     openspec/changes/extract-runner-minutes-ledger/assertion-rewrite-ledger.md (new).
     Every one of these has exactly one writer: this track.
     Deliberately serial and fat: specs/domain-event-bus (lines 74-77) requires the two shared writer
     source files and the hard-coded ratchet test to be integrated on ONE track.
     Depends on owner-and-port ONLY — 4.1/4.2/4.4 import that track's port, token and factory. The
     characterization-proof dependency the draft declared was not a file dependency: the obligation
     is that track 2's test lands in an EARLIER COMMIT, which integration task 5.1 enforces.
     MUST NOT touch: apps/api/src/guardrails/*.spec.ts, apps/api/src/guardrails/*.test.mjs,
     packages/contracts/**, docs/**, the two bare `.ts` files in apps/api/src/runner-metrics/,
     track 1's and track 2's test files, the GuardrailsService constructor signature, or the 22
     positional `new GuardrailsService(...)` sites across 15 files. -->

- [x] 4.1 In `guardrails.service.ts`, replace the import block at `:109-112` (`RunnerMinutesLedger` + `type RunningInterval` from `@/runner-metrics/runner-minutes`) with a single import from `@/runner-metrics/runner-minutes-ledger.port.ts` naming the port type, the token, and `createDetachedRunnerMinutes`. `RunningInterval` is referenced only at `:3879` (the accessor being deleted), so it leaves with it — verify no other use survives.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.2 Replace the data field at `:593` (`private readonly runnerMinutes = new RunnerMinutesLedger();`) with THREE declarations: `private ownedRunnerMinutes?: RunnerMinutesPort;` (filled by DI in 4.3), `private readonly detachedRunnerMinutes: RunnerMinutesPort = createDetachedRunnerMinutes();`, and `private get runnerMinutes(): RunnerMinutesPort { return this.ownedRunnerMinutes ?? this.detachedRunnerMinutes; }`. **Do NOT keep a data field named `runnerMinutes` and assign to it** — an assignment `this.runnerMinutes = …` is itself a counted symbol reference, so that shape leaves R11 at 6 and delivers zero movement (measured). The accessed member name stays `runnerMinutes`, so the five call sites are untouched.
  - requirements: ["guardrails/in-place-and-unchanged-governs-the-seam-and-this-change-keeps-the-call-text-byte-identical-anyway", "runner-minutes-accounting/running-interval-state-has-exactly-one-owner-and-it-lives-in-platform-ops"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.3 Write the doc comments for those three declarations **without the literal `this.runnerMinutes` anywhere in them**. `measureSource` (`scripts/ratchets/r11-dependency-budget.mjs:118-134`) splits raw source and regex-matches line by line with no comment stripping, and `r11-dependency-budget.test.mjs:205` pins that behaviour deliberately by feeding a bare `// this.audit` comment and expecting it to count. A doc comment quoting the symbol silently restores the reference this change removes.
  - requirements: ["guardrails/in-place-and-unchanged-governs-the-seam-and-this-change-keeps-the-call-text-byte-identical-anyway", "domain-event-bus/the-runner-minutes-budget-entry-falls-from-6-to-5-as-a-measured-first-decrease-not-a-burn-down"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.4 Extend the **existing** `onModuleInit()` at `:787` with a `this.moduleRef.get(RUNNER_MINUTES_PORT, { strict: false })` resolution guarded by try/catch, following the `gateway` / forge-resolver idiom already in that method. Assign the result to **`this.ownedRunnerMinutes`**, never to `this.runnerMinutes`; on failure leave it unset so the getter keeps returning the detached fallback, and say in the comment that the runner-metrics module is not wired in this context. Do not add a new lifecycle hook and do not touch `onApplicationBootstrap`.
  - requirements: ["runner-minutes-accounting/running-interval-state-has-exactly-one-owner-and-it-lives-in-platform-ops", "guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.5 Before committing, run the gate's own measurement over the edited file — import `measureSource` from `scripts/ratchets/r11-dependency-budget.mjs` and print the `this.runnerMinutes` count and its sample lines — and confirm it returns exactly **5**, the five write sites and nothing else. If it returns 6, find which added line reintroduced the symbol (assignment, type annotation, or comment) and fix that rather than lowering the baseline.
  - requirements: ["domain-event-bus/the-runner-minutes-budget-entry-falls-from-6-to-5-as-a-measured-first-decrease-not-a-burn-down"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.6 Delete the forwarding accessor together with its doc comment: `:3878` is the doc comment and `:3879-3881` is the method body (`runnerMinuteIntervals(): RunningInterval[] { return this.runnerMinutes.intervals(); }`); `:3877` is the preceding blank line, so remove `:3878-3881` and leave one blank line separating the neighbours. Leave **no** replacement forwarder, no deprecated stub, and no empty method body on any orchestrator.
  - requirements: ["runner-minutes-accounting/the-metrics-reader-calls-the-owner-directly-and-no-forwarder-survives", "guardrails/the-runner-minutes-read-face-is-removed-under-a-proven-owner-while-every-write-is-retained"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.7 Diff-check the five surviving write sites (`recordStart` at `:1824`/`:2917`/`:3286`, `recordEnd` at `:2319`/`:3264`): each statement must be byte-identical **to its own pre-change text** — they are NOT byte-identical to each other, since `:1824` carries six-space indentation while `:2917`/`:3286` carry four, so compare each line against its own prior form and never against a sibling. Each must still sit inside the same method. `git diff` filtered to lines containing `this.runnerMinutes` must show exactly one deletion hunk and zero modification hunks.
  - requirements: ["guardrails/the-runner-minutes-read-face-is-removed-under-a-proven-owner-while-every-write-is-retained", "guardrails/in-place-and-unchanged-governs-the-seam-and-this-change-keeps-the-call-text-byte-identical-anyway"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.8 Confirm each of the three `TaskRunStarted` publish points still sits on the same side of its retained `recordStart`, and that `fenceTerminal` and `clearAdmissionRuntime` still invoke `recordEnd` exactly once each with `clearAdmissionRuntime` publishing zero `TaskSettled`. The seam, not the byte text, is what the existing spec protects — but this change preserves both.
  - requirements: ["guardrails/in-place-and-unchanged-governs-the-seam-and-this-change-keeps-the-call-text-byte-identical-anyway"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.9 Verify the constructor is untouched: same 11 parameters in the same order and types, `@Optional()` bus still last, and zero of the 22 positional `new GuardrailsService(...)` sites across 15 files edited to pass a ledger or port argument.
  - requirements: ["guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.10 Run `apps/api/src/guardrails/guardrails.service.spec.ts` and confirm it passes with **zero diff lines**, including all 14 reflective `internals.runnerMinutes` occurrences at `:1375`/`:1380`, `:3011`/`:3021`, `:3072`/`:3078`, `:3132`/`:3136`, `:3199`/`:3207`, `:3274`/`:3280`, `:3341`/`:3347`. If any assertion requires an edit, stop: the move changed behaviour and the move is what is wrong, not the test.
  - requirements: ["guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.11 In `metrics.service.ts`, inject the runner-minutes port and feed `deriveRunnerMinutes` from it at `:74`, replacing `this.guardrails.runnerMinuteIntervals()`. Keep the `semaphoreProjection()` dependency on guardrails exactly as it is — this change lowers the source-level edge only, so `cross-context-import:apps/api/src/metrics/metrics.service.ts` stays at 2.
  - requirements: ["runner-minutes-accounting/the-metrics-reader-calls-the-owner-directly-and-no-forwarder-survives"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.12 Wire the owner into the module graph: import the new runner-minutes module from `metrics.module.ts` (so the port injects) and from `app.module.ts` (so the guardrails `ModuleRef` lookup resolves in a booted app). Leave `metrics.module.ts`'s existing `GuardrailsModule` import in place — it is a module-level edge that r7 does not count and that this change does not claim to remove.
  - requirements: ["runner-minutes-accounting/running-interval-state-has-exactly-one-owner-and-it-lives-in-platform-ops"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.13 Restate the four test doubles that stubbed the removed accessor, each preserving its existing fixture values and per-assertion strength: `metrics.verify.test.mjs:468`, `metrics.verify.test.mjs:537`, `task-resource.test.mjs:137`, `terminal-diagnostics-metrics.service.spec.ts:71`. Each now supplies intervals through a runner-minutes port double instead of a fake guardrails accessor.
  - requirements: ["guardrails/test-doubles-of-the-removed-accessor-are-restated-and-every-rewrite-is-ledgered"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.14 Grep `apps/api/src` for the identifier `runnerMinuteIntervals` and confirm **zero** matches — production code and test doubles alike. A surviving match in a stub means step 4.13 is incomplete.
  - requirements: ["runner-minutes-accounting/the-metrics-reader-calls-the-owner-directly-and-no-forwarder-survives"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.15 Create `openspec/changes/extract-runner-minutes-ledger/assertion-rewrite-ledger.md` with the five-column form used by the previous change's adjudication table. Expected content: exactly one entry — `terminal-diagnostics-metrics.service.spec.ts:71`, a `*.spec.ts` outside the guardrails directory whose own subject this change alters — classified (a) or (b), recording what the original assertion pinned, why it no longer holds, and the invariant the replacement pins. If the count turns out to be zero, write "zero entries" explicitly rather than omitting the section.
  - requirements: ["guardrails/test-doubles-of-the-removed-accessor-are-restated-and-every-rewrite-is-ledgered"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 4.16 Lower `scripts/ratchets/r11.json`'s `guardrails-symbol-reference:this.runnerMinutes` entry from `count: 6` to `count: 5`. Do **not** delete the entry — its live count is still above zero — and do not touch its `symbol` field.
  - requirements: ["domain-event-bus/the-runner-minutes-budget-entry-falls-from-6-to-5-as-a-measured-first-decrease-not-a-burn-down"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.17 Refresh that entry's `samples` in the same edit: replace all six stale lines (`1566/2038/2623/2949/2971/3555`, one full generation out of date) with the five surviving references at their post-change live line numbers. Zero lines may carry over from the stale generation.
  - requirements: ["domain-event-bus/the-runner-minutes-budget-entry-falls-from-6-to-5-as-a-measured-first-decrease-not-a-burn-down"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.18 Rewrite that entry's `change` field wholesale — its current text ("recordStart/recordEnd 改订阅") describes an event-subscription route that Q1 measured to be capped at 1 and that this change does not take, so leaving it in place mis-documents the burn-down route for the next author. The replacement carries the anti-forgery reconciliation: 6 − 5 = 1 equals exactly the one removed read reference (`return this.runnerMinutes.intervals();`); the measured symbol string is unchanged; the count was verified with the gate's own `measureSource` over the edited file, not inferred from the deletion. State the outcome as a **FIRST DECREASE**, and state that 6 → 0 is structurally unreachable while the five write references remain. The words "burned down" must not appear for this collaborator.
  - requirements: ["domain-event-bus/the-runner-minutes-budget-entry-falls-from-6-to-5-as-a-measured-first-decrease-not-a-burn-down", "domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.19 Confirm the other five `r11.json` entries are **byte-identical** to their form at the start of this change: `this.audit` 9, `provisioningDiagnosticRecorder` 4, `provisioningDiagnosticWriteGate` 4, `this.transcripts` 2, metrics-projection 2 — unchanged in count and in `symbol`.
  - requirements: ["domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.20 Update the hard-coded expected mapping in `scripts/ratchets/r11-dependency-budget.test.mjs` (around `:73`) to `this.runnerMinutes` = 5, in this same track so it lands in the same commit as the `r11.json` edit.
  - requirements: ["domain-event-bus/the-runner-minutes-budget-entry-falls-from-6-to-5-as-a-measured-first-decrease-not-a-burn-down"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.21 Verify no comment line this track added to `guardrails.service.ts` contains a quoted catalog event name — `guardrails-domain-event-publishing.spec.ts` asserts exact whole-file occurrence counts of those names, and a stray mention in a comment turns it red. Likewise, write no research conclusions into this file; they belong in `research-findings.md`.
  - requirements: ["guardrails/the-runner-minutes-read-face-is-removed-under-a-proven-owner-while-every-write-is-retained"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.22 Lower `scripts/ratchets/r7.json`'s `cross-context-import:apps/api/src/guardrails/guardrails.service.ts` entry from `count: 9` to `count: 8`, in this track so it lands in the same commit as 4.1's import change. This task was ADDED when the partition was corrected, because no drafted task owned that file and the omission is fail-closed: the shared comparator (`scripts/ratchets/comparator.mjs`) treats a measured count BELOW its baseline as "equally red" to one above, so deleting the illegal `@/runner-metrics/runner-minutes` import without shrinking the entry turns `pnpm test:context-layout-v2` red on a stale entry — which is what task 5.7 would otherwise discover at integration. Touch nothing else in that file: `cross-context-import:apps/api/src/metrics/metrics.service.ts` stays at 2 (measured — `metrics` and `runner-metrics` are the same platform-ops context, so 4.11's port injection is not a cross-context edge at all), and both `unclassified-file:apps/api/src/runner-metrics/{runner-minutes,metrics-projection}.ts` entries stay present at 1. The entry's two `samples` name forge imports this change does not touch, so leave them and the `change` field exactly as they are.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 5. Track: gates-and-verification (depends: owner-and-port, characterization-proof, range-b-research, ownership-move-and-ratchet)

<!-- Integration track: serial, runs after everything, and the only place shared-file work happens.
     Writes:
       - openspec/changes/extract-runner-minutes-ledger/research-findings.md — APPENDS this change's
         MEASURED row (5.9) to the artifact track 3 created; the one cross-artifact reconciliation
         that cannot live inside a parallel track;
       - openspec/changes/extract-runner-minutes-ledger/surface-impact.json — 5.13's `internalOnly.scope`
         rewrite (no parallel track touches it);
       - openspec/changes/extract-runner-minutes-ledger/tasks.md — reconcile the `- [x]` ledger across
         the merged worktrees before declaring done; lost checkboxes are this workflow's known
         failure mode, so recount rather than trusting any one worktree's copy;
       - the recorded outputs of 5.8/5.12 wherever the change directory keeps them.
     Tasks 5.3 and 5.11 need an executable home. If one is added it MUST be a NEW file of this
     track's own (e.g. apps/api/src/runner-metrics/runner-minutes-ownership.integration.test.mjs) —
     never an append to track 1's `runner-minutes-ledger.port.test.mjs` or track 2's
     `runner-minutes-derivation.test.mjs`, whose byte-identity 5.2 asserts.
     Everything else here is read-and-run.
     Branch discipline, re-measured: the working tree is ALREADY on
     `refactor/extract-runner-minutes-ledger` (not `main`), with the change directory still
     untracked and no commit of this change made yet. 5.1 therefore verifies the branch and does the
     two ordered commits; it does not create a second branch. -->

- [x] 5.1 Confirm the working branch (measured at partition time: already on `refactor/extract-runner-minutes-ledger`, forked from `main`, with no commit of this change yet) and create it off `main` only if it is missing — nothing in this change may be committed onto `main`, and a second branch must not be cut over the first. Then commit in **two ordered commits**: first the characterization test from track 2 alone, then everything else. The spec requires the test to be introduced by a commit that precedes the ownership move; verify with `git log --oneline` and confirm no later commit in the change edits that file.
  - requirements: ["runner-minutes-accounting/the-derived-output-is-proven-unchanged-by-a-characterization-test-bound-to-the-real-implementation"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.2 Re-run the characterization test on the integrated tree and confirm it passes **unmodified** — byte-identical to the file track 2 committed. Any required edit means the move altered behaviour; fix the move, not the test.
  - requirements: ["runner-minutes-accounting/the-derived-output-is-proven-unchanged-by-a-characterization-test-bound-to-the-real-implementation"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.3 Prove one instance serves both sides in a booted context: record a run start through the guardrails write path, then build the metrics response, and assert `runnerMinutes.available` is true and counts that task's interval. Additionally assert the orchestrator's port field is object-identical to the provider registered under the DI token, and that the detached instance the field initializer produced recorded zero intervals.
  - requirements: ["runner-minutes-accounting/running-interval-state-has-exactly-one-owner-and-it-lives-in-platform-ops"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.4 Search the integrated tree for `new RunnerMinutesLedger(` and confirm every match is inside `apps/api/src/runner-metrics/` with zero inside `apps/api/src/guardrails/`. Then list every import of `apps/api/src/runner-metrics/*` originating outside that directory, excluding `*.module.ts` composition files, and confirm each names the `*.port.ts` and none names the owner's `*.service.ts`.
  - requirements: ["runner-minutes-accounting/running-interval-state-has-exactly-one-owner-and-it-lives-in-platform-ops", "runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.5 Search for `createDetachedRunnerMinutes(` outside test files and confirm exactly one call site — the `guardrails.service.ts` field initializer.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.6 Enumerate the guardrails public methods and cross-reference their call sites: confirm zero methods exist whose body only forwards to the runner-minutes port and which have no call site.
  - requirements: ["runner-minutes-accounting/the-metrics-reader-calls-the-owner-directly-and-no-forwarder-survives"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.7 Run the r7 comparator against `scripts/ratchets/r7.json` and confirm: `cross-context-import:apps/api/src/guardrails/guardrails.service.ts` reads **8** (down from 9), `cross-context-import:apps/api/src/metrics/metrics.service.ts` still reads **2**, both `unclassified-file:apps/api/src/runner-metrics/{runner-minutes,metrics-projection}.ts` entries are still present with count 1, no recorded count rose, and no new key appeared.
  - requirements: ["runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.8 Run the full gate set on the integrated tree and record each result: `pnpm test:dependency-budget` (R11 — recorded count 5 and a live re-count of 5), `pnpm test:context-layout-v2`, the api-module-layout check, the test-discovery gate, `pnpm test:scripts`, and the repository typecheck/lint. Confirm the two CI step display names this change touches — `Context layout gate (v2, report)` and `Dependency budget ratchet (R11)` — are byte-identical to their current text.
  - requirements: ["domain-event-bus/the-runner-minutes-budget-entry-falls-from-6-to-5-as-a-measured-first-decrease-not-a-burn-down", "runner-minutes-accounting/cross-context-access-to-the-ledger-is-only-through-a-port-file-and-di-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.9 Fill this change's own **measured** row in `research-findings.md` from the integrated tree — guardrails line count before and after, `this.runnerMinutes` 6 → 5, r7 `guardrails.service.ts` 9 → 8, 0 forwardRef cycle edges removed, and the count of test files changed — and mark none of these five cells as a prediction. Reconcile the row against the r11 entry's `change` field so the two artifacts cannot disagree.
  - requirements: ["guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 5.10 Run the runtime-coupling structural probes (the `sandbox-host-harness-wiring.test.mjs` family, which scan source text rather than behaviour) and confirm the file-composition change did not turn any of them red. Separately confirm the owner, the port, and the module file contain zero `Logger` / `console.` / injected-logger matches.
  - requirements: ["runner-minutes-accounting/the-ownership-move-adds-no-runtime-behavior-and-no-observable-output-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.11 Prove the response body is unchanged: build `GET /metrics` from the same interval fixture and the same frozen `now` before and after the move and assert the two bodies are deep-equal, including the `runnerMinutes` block's `available` and `minutes` fields. Confirm `packages/contracts/**` appears nowhere in the change's diff.
  - requirements: ["runner-minutes-accounting/the-ownership-move-adds-no-runtime-behavior-and-no-observable-output-change"]
  - surfaces: ["public-v1"]
  - verify: "workflow-gates"
- [x] 5.12 Actually run `node scripts/public-surface-adversarial.mjs verify extract-runner-minutes-ledger` — declaring `unchanged` is not a substitute for executing it — and record its output in the change. It must exit 0 against `unchanged` on all four surfaces with an empty `protocolDifferences`.
  - requirements: ["runner-minutes-accounting/the-ownership-move-adds-no-runtime-behavior-and-no-observable-output-change"]
  - surfaces: ["public-v1", "mcp", "openapi", "playground"]
  - verify: "workflow-gates"
- [x] 5.13 Update `surface-impact.json`'s `internalOnly.scope` to match what actually shipped: the class already lived in `runner-metrics`, so this is Move Field + Remove Middle Man rather than an Extract Class, and the R11 outcome is 6 → 5 rather than a burn-down. Leave all four surface statuses at `unchanged` and `protocolDifferences` empty.
  - requirements: ["runner-minutes-accounting/the-ownership-move-adds-no-runtime-behavior-and-no-observable-output-change"]
  - surfaces: ["public-v1"]
  - verify: "workflow-gates"
- [x] 5.14 Final scope audit before opening the PR: the diff contains zero files under `apps/api/src/guardrails/*.spec.ts` or `*.test.mjs`, zero files under `packages/contracts/`, and no edit to `docs/refactor/contexts-manifest.json` (this change adds no new directory). The plan-document edits are IN scope and must be present: the Q4 decision made the acceptance-target replacement this change's own work (`guardrails/the-phase-4-numeric-acceptance-target-is-replaced-by-criteria-that-each-name-their-gate` — "The replacement SHALL be performed by this change rather than deferred"), so confirm the docs side of the diff is exactly the three files tasks 3.14-3.16 name — `docs/refactor-master-plan.md`, `docs/refactor/08-ddd-target-architecture.md`, `docs/refactor/07-baselines-and-dependencies.md` — and no other document, archived directories included. A diff with zero plan-document edits is now a defect, not clean scope; the draft's earlier "not an edit this change makes" wording predates that decision and does not govern.
  - requirements: ["guardrails/test-doubles-of-the-removed-accessor-are-restated-and-every-rewrite-is-ledgered", "guardrails/the-remaining-collaborator-groups-are-scoped-by-a-durable-precondition-graph-and-measured-outcome-table"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 6. Track: verify-reopened (depends: none)

- [x] 6.1 Remove `apps/api/src/guardrails/ground-truth-publishing-failure-does-not-disturb-transition.spec.ts` from the tree (or relocate it outside `apps/api/src/guardrails/` if its coverage is judged worth keeping permanently). The file is a 229-line runnable `*.spec.ts` added during verification as a ground-truth probe for the MODIFIED `guardrails` scenario "Publishing failure does not disturb the transition"; its own header declares it "not part of the permanent suite". It is currently **untracked but present**, and it names `extract-runner-minutes-ledger` in its header, so it is this change's working-set artifact. While it sits there the guardrails characterization baseline this change is required to leave untouched is **7 `*.spec.ts` files / 136 `test()`** instead of the pinned **6 files / 135 `test()`** (`ls apps/api/src/guardrails/*.spec.ts | wc -l` → 7; `grep -ho 'test(' apps/api/src/guardrails/*.spec.ts | wc -l` → 136; excluding this one file both numbers return to 6 / 135 exactly). It also makes the change's own `assertion-rewrite-ledger.md` §3 claim ("Guardrails-directory spec or `.test.mjs` files edited: **0** — the guardrails characterization baseline … is untouched by this change") false on the live tree, and it would enter the diff the moment archive stages the working tree. Acceptance: `ls apps/api/src/guardrails/*.spec.ts | wc -l` = 6, `grep -ho 'test(' apps/api/src/guardrails/*.spec.ts | wc -l` = 135, `ls apps/api/src/guardrails/*.test.mjs | wc -l` = 8, `git status --porcelain apps/api/src/guardrails/` empty, and `assertion-rewrite-ledger.md` §3 re-reads true without edit. Do **not** satisfy this by weakening the baseline numbers in either spec file — the frozen baseline is the requirement, not a reporting convenience.
  - requirements: ["runner-minutes-accounting/the-derived-output-is-proven-unchanged-by-a-characterization-test-bound-to-the-real-implementation", "guardrails/test-doubles-of-the-removed-accessor-are-restated-and-every-rewrite-is-ledgered"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
