# Verification report — close-phase-four

One verify pass is recorded here, and it is the pass whose tally gates archive: **zero** re-opened
code tasks, **zero** spec defects, **zero** archive-blocking spec defects. Archive is not gated.

Tree verified: branch `refactor/close-phase-four`, HEAD `78d94de` ("feat(openspec): close phase 4 —
the acyclic edge, its gate, and an honest acceptance record"), working tree clean at the time of
measurement (`git status --short` empty), so every figure below was read off committed state rather
than off an uncommitted edit.

Executable baseline re-run during adjudication:

- `node scripts/spec-assert.mjs close-phase-four` → **7/7 passed**, 2 requirements decided without an
  LLM pass. (The gap note carried in from the apply-side report says "6 assertions"; the file holds
  **7** — `assertions.json` gained `tasks-module-imports-guardrails-plainly`. The undercount is in the
  prose, not in the gate: all seven run and all seven pass.)
- `node scripts/module-composition-cycle-check.mjs` → exit 0, prints `module composition: neither of
  the 2 adjudicated module files wraps the other in forwardRef (comments naming the retired one are
  kept on purpose).`
- `node --test --test-force-exit scripts/module-composition-cycle-check.test.mjs` → **9/9 pass, 0 fail**.
- `node scripts/public-surface-adversarial.mjs verify close-phase-four` → `findings: []`; sidecar,
  registry, restMetadata, mcpSdkMetadata and behavior sub-checks all `passed: true`.
- `pnpm test:dependency-budget` (R11) → **12/12 pass**. `pnpm test:context-layout-v2` (r7) → **29/29 pass**.
  These two are what make the numbers this change wrote into `docs/refactor-master-plan.md`
  tree-synced rather than prose: the plan's figures are re-derivable by the commands it names.
- `node scripts/spec-assert.mjs archive/2026-08-06-retire-legacy-inline-admission` → **34/34 passed**,
  confirming the predecessor tripwire this change tripped during apply is green again (see §Scope).

## Adjudication summary

| Route | Count | Ids |
| --- | --- | --- |
| Re-opened as code tasks | 0 | — |
| Spec defects (design.md Open Questions) | 0 | — |
| Archive-blocking spec defects | 0 | — |
| Re-classified / confirmed MET | 2 | both requirements, below |

The raw verify pass produced **no** unmet findings and **no** mandatory public findings. Rather than
rubber-stamp that, both requirements were re-traced end-to-end against the committed tree — scenario
by scenario, with the gate driven directly on planted inputs — and both hold. The two residual
observations recorded at the end are matcher-shape notes, not unmet scenarios; neither blocks a
primary scenario, so neither is routed to a code task.

## MET — `monorepo-foundation/the-tasks-guardrails-composition-edge-carries-no-forwardref-and-a-gate-says-so`

Re-traced against all four scenarios.

**Scenario 1 — the vestigial forwardRef is gone and the import is plain.** `tasks.module.ts:1` is
`import { Module } from '@nestjs/common';` — `forwardRef` no longer enters the file. The module's
`imports` array lists `GuardrailsModule,` plainly alongside `SandboxEnvironmentsModule`, `ForgeModule`
and `TaskAdmissionModule`. The doc paragraph at `:43-53` was rewritten and no longer claims a cycle:
it states the import is plain, that `guardrails.module.ts` declares `imports: []`, that no non-test
file under `apps/api/src/guardrails/` imports `@/tasks`, that metrics/settings/terminal are the
precedent, and that `GUARDRAILS_SERVICE_TOKEN` decouples `TasksService` from the concrete class —
which is not the same thing as breaking a cycle. `guardrails.module.ts:63` was correctly left alone;
its comment is past-tense.

The premise the requirement rests on re-measures true: `grep -rn 'forwardRef' apps/api/src --include='*.ts'`
excluding tests returns **four hits, all of them comment lines** (`app.module.ts:149`,
`tasks.module.ts:47`, `guardrails.module.ts:63`, `session-transcript.module.ts:18`). There is no live
`forwardRef` call anywhere in the API today, and no non-test file under `guardrails/` imports `@/tasks`.

**Scenario 2 — a reintroduced forwardRef fails the gate.** Driven directly:
`findForwardRefViolations('    forwardRef(() => GuardrailsModule),', 'GuardrailsModule')` returns one
hit at the right line. `main()` then exits 1 and prints `${file}:${line} wraps ${forbids}` — the file
AND the direction, as the scenario requires. The bare-call fallback (`forwardRef\s*\(` plus the module
name on the same line) also catches indirect spellings such as
`forwardRef(() => require('...').GuardrailsModule)`.

**Scenario 3 — the gate fails when it loses its subject.** `checkEdge` pushes to `missing` and
`main()` returns 1 with an error that says in as many words that this is a FAILURE, not a pass, and
tells the next author to update `EDGE` in the same commit as the move. Self-tested twice, from both
ends: once through an injected `exists` that hides `tasks.module.ts`, and once through
`main({ root: '/nonexistent-root-for-this-test' })`. This is the "green because it found nothing"
failure mode the requirement names, and it is closed by construction — the gate opens both files or
fails.

**Scenario 4 — registered like every other narrow check.** `scripts/module-composition-cycle-check.mjs`
with `scripts/module-composition-cycle-check.test.mjs` beside it, wired to one script at
`package.json:22`:

```
"test:module-composition": "node scripts/module-composition-cycle-check.mjs && node --test --test-force-exit scripts/module-composition-cycle-check.test.mjs",
```

byte-for-byte the shape of its eleven siblings (`test:discovery`, `test:cors-headers`,
`test:module-layout`, …). Checked beyond the letter of the scenario: the gate is not merely
registered but actually **runs in CI**. `.github/workflows/ci.yml:426` runs `pnpm test:scripts`, which
globs `scripts/*.test.mjs` by pattern and therefore discovers this self-test without anyone editing
the workflow — and because the self-test's first and last cases assert the LIVE tree
(`checkEdge()` clean, `main()` → 0), CI failing on a reintroduced forwardRef does not depend on
anybody having remembered to add a step. This was the most plausible way for this requirement to be
satisfied on paper and dead in practice, and it is not the case here.

## MET — `guardrails/phase-4-s-acceptance-record-states-measured-values-and-names-what-it-defers`

Re-traced against all three scenarios, and against the live ratchets rather than against the prose.

**Scenario 1 — every phase-4 criterion can be passed or failed by reading it.** The acceptance table
(`docs/refactor-master-plan.md:161-166`) now carries a judging command in every row. Row (c)
(`:165`) states `r7 cross-context-import = **7**（裁定值，2026-08-07 实测）` with
`pnpm test:context-layout-v2`; the stale parenthetical that said 9 is gone, and note c (`:180-184`)
enumerates the seven surviving imports by line (forge ×3 `:92 :93 :94`, sandbox `:99`,
agent-runtime `:126`, task-provisioning-diagnostics ×2 `:139 :147`) and explains why 7 is the FLOOR
rather than a way-station — all seven are calls or types with return values, which the plan's own
non-event criterion (`:133-135`) puts structurally out of reach of phase 4's mechanism, and they are
retired instead by the `*.port.ts` mechanism the r7 entry itself names, in phases 5-6. Row (d)
(`:166`) names `pnpm test:module-composition`. Row (a) names `pnpm test:dependency-budget`, whose
per-entry floors are stated at `:145-147`.

Not taken on faith: `scripts/ratchets/r7.json` holds `count: 7` for
`cross-context-import:apps/api/src/guardrails/guardrails.service.ts`, and `pnpm test:context-layout-v2`
is green (29/29) — so 7 is what the tree measures today, not a number frozen into prose. Assertion
`criterion-c-states-the-measured-floor` re-derives the figure from `r7.json` at assert time rather
than grepping a literal, which is why it would go red on drift instead of going stale with the doc.

**Scenario 2 — the deferred criterion is a decision on the record.** Row (b) (`:164`) reads
**推到阶段 6（用户 2026-08-07 拍板）**, and note b (`:170-178`) supplies the measurement behind it:
all six constructions located by line in `guardrails.service.ts` (Logger `:470`,
ConcurrencySemaphore `:724`, TaskProvisioningDiagnosticsObserverLifecycle `:748`, DeadlineWatcher
`:762`, IdleTracker `:767`, CircuitBreaker `:770`); the argument that five are the orchestrator's own
mechanisms by every instrument the repo owns (same directory, same context, sole production importer,
absent from `COLLABORATORS`, absent from r7); and the reason the sixth is cross-cutting yet built
locally on purpose — `guardrails.service.ts:740-746` requires the frozen out-of-directory specs and
the wired application to share ONE construction path, which injection would split into a DI path and
a test path. The note closes by saying plainly that phase 4 therefore closes **带着一条明确延期的判据
收口，不是四条全达成**, and says why that sentence is there: so a later reader can disagree with the
decision rather than mistake it for an omission. That is exactly what the scenario asks for.

**Scenario 3 — the refuted numbers are corrected where they were stated.** `:146-147` now reads
`runner 计费实测地板 **4**` with the mechanism that took the fifth (legacy retirement carried a further
`recordStart` away with `startRunningAfterCapacity`), and `diagnostics 组 legacy 存活时 4、**退役后仍
是 4**（recorder 2 + writeGate 2）`. Both re-measure true against `scripts/ratchets/r11.json`:
`this.runnerMinutes → 4`, `provisioningDiagnosticRecorder → 2`, `provisioningDiagnosticWriteGate → 2`
(and `this.audit → 9`, `this.transcripts → 1`, `metrics-projection → 2`), with
`pnpm test:dependency-budget` green at 12/12.

The requirement's harder clause — that the refutation be KEPT rather than erased — is satisfied
literally: the ⚠ paragraph at `:148-152` preserves the "退役后 2" prediction, names
`retire-legacy-inline-admission` as having corrected it in the live spec and in
`scripts/ratchets/r11.json` while missing this file, gives the mechanism (the orchestrator's single
read of the pair fed two consumers; retirement took only the legacy one), and states why the record
is kept: 「预言保留在此不是留错，是留下它被推翻的记录」. A silent overwrite would have passed a
naive grep and failed this requirement; it did not happen.

## Gap findings

Recorded verbatim from the pass:

> Both requirements in the change checked out with working, executable traceable implementation (gate
> script + self-test + package.json wiring for the monorepo-foundation requirement; the three
> corrected doc passages in `docs/refactor-master-plan.md` for the guardrails requirement), and all 6
> assertions in `assertions.json` plus the gate's own 9-test self-test pass on the live tree.
>
> **Result: no gaps found.**
>
> ```json
> []
> ```

One correction to that note, made here rather than left to drift: `assertions.json` holds **7**
assertions, not 6, and all 7 pass (`node scripts/spec-assert.mjs close-phase-four` → 7/7). The
self-test count (9) is right.

## Scope findings

Recorded verbatim from the pass:

> ```json
> [
>   "Reworded e2e comment explaining absence of `force_failed:provision_failed` (avoids tripping the archived predecessor change's `no-symbol-reaches-pipeline` assertion) — apps/web/e2e/scheduled-tasks/scheduled-tasks.spec.ts:500-503; explicitly disclosed in proposal.md's 'apply 期发现（记录，非本刀计划内）' section as found-during-apply and out of this change's planned scope, and does not map to either requirement in close-phase-four/specs (monorepo-foundation's forwardRef-gate requirement or guardrails' acceptance-record requirement)"
> ]
> ```

Adjudicated as **in-scope-by-disclosure, not an undeclared surface change**, on three grounds, each
checked rather than accepted:

1. **It is disclosed.** `proposal.md` carries the finding under 「apply 期发现（记录，非本刀计划内）」,
   states that the safety property was never broken (no symbol reaches the retired pipeline; the hit
   was a prose path reference), and states what was changed and why.
2. **It restores a gate rather than relaxing one.** `node scripts/spec-assert.mjs
   archive/2026-08-06-retire-legacy-inline-admission` → **34/34 passed**. The reworded comment at
   `scheduled-tasks.spec.ts:499-509` keeps the whole explanation — the three producers, the file that
   owned them, the surviving declared-union-member shape — and explicitly says why the file is not
   named: 「the retirement's own tripwire greps for its name everywhere including prose, deliberately,
   and naming it would turn this explanation into a violation」. Information preserved, literal avoided.
3. **It carries zero public-surface consequence.** `surface-impact.json` declares `intent: internal`,
   `runtimeWireBehavior: unchanged`, all four public surfaces `unchanged`, `protocolDifferences: []`.
   `node scripts/public-surface-adversarial.mjs verify close-phase-four` returns `findings: []` with
   sidecar/registry/restMetadata/mcpSdkMetadata/behavior all passing — the sidecar claim is
   machine-confirmed, not merely asserted, so there is no false exclusion to block archive on.

The proposal also records the口径 inconsistency this exposed inside the predecessor change
(`boot-reoffer-gone-from-code` deliberately excludes comments, `no-symbol-reaches-pipeline` does not)
and declines to build the "predecessor-assertion channel" tooling here, correctly: that is a
toolchain change and the master plan does not list it as a phase-4 closing item. Noted as a real
follow-up candidate, not as a defect of this change.

## Residual observations (recorded, not re-opened)

Neither of these is an unmet scenario. Both are properties of a deliberately narrow, line-oriented
matcher, and both are recorded so the next author who widens the gate knows what it does and does not
see today.

1. **The detector is line-oriented.** A hand-wrapped `forwardRef(\n  () => GuardrailsModule,\n)` is
   not caught — driven and confirmed: `findForwardRefViolations` returns `[]` for the wrapped form and
   one hit for the single-line form. The realistic reintroduction path is Nest's own cyclic-dependency
   error message, which hands the author `forwardRef(() => GuardrailsModule)` — 36 characters
   indented, which nothing wraps — and that form is caught, so the scenario as written ("a
   `forwardRef(` naming the other module is added") holds for the case it exists to stop. Widening to
   a multi-line/AST match would be a strict improvement, and there is no repo-root Prettier config or
   CI format step to normalise the wrap for it, but this is a hardening, not a missing defence.
2. **An aliased import evades it** (`import { forwardRef as fr }` → `fr(() => GuardrailsModule)`
   returns `[]`). Deliberate evasion of a gate one is choosing to install a cycle past is outside what
   any grep-class check in `scripts/` defends against, and is not what the requirement's threat model
   describes — an author who does not realise the cycle was already broken.
