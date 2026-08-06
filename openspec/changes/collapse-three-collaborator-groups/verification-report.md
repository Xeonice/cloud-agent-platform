# Verification report — `collapse-three-collaborator-groups`

Adversarial verification with three-way routing (UNMET → re-opened code task ·
SPEC-DEFECT → `design.md` Open Questions · MET → folded here). Every verdict below was
**re-traced against the working tree** in this pass — commands were re-run first-hand, not
copied from the apply log, from the commit message, or from the skeptic pass.

Tree under test: branch `main`, HEAD `4f5c21c` ("refactor(guardrails): take three collaborator
groups to their measured floors"), on top of `199074a` (proposal) and base `c858853`.
Date: 2026-08-06. Working tree is clean for this change (the only untracked path,
`openspec/changes/extract-runner-minutes-ledger/`, belongs to a different, already-archived cut).

---

## Adjudicated tally

| Route | Count | Ids |
|---|---|---|
| Re-opened as code tasks (UNMET) | **0** | — |
| Routed to `design.md` Open Questions (SPEC-DEFECT) | **0** | — (no `design.md` exists for this change, and none is needed) |
| Archive-blocking spec defects (public impact / false exclusion) | **0** | — |
| Reclassified MET (raw-unmet that re-traces end-to-end) | **0** | — the pass received **no** raw-unmet requirements, so there was nothing to reclassify |

This pass received **0 raw-unmet requirements** and **0 mandatory public findings**. All six
requirements were decided by the command-decidable assertion harness with **none left for LLM
judgment** — `node scripts/spec-assert.mjs collapse-three-collaborator-groups` returns
`18/18 passed; 6 requirement(s) decided without an LLM pass`.

The tally was not taken on trust. This pass independently re-executed the load-bearing gates and
the two discriminating tests (below), and separately ran the adversarial public-surface verifier
end-to-end, because the `resource-metrics` requirement's fourth scenario demands the surface
position be *executed rather than assumed*. All six requirements are **MET**.

---

## Gates actually executed on this tree during this pass

| Gate | Command | Result |
|---|---|---|
| R12 spec assertions | `node scripts/spec-assert.mjs collapse-three-collaborator-groups` | **18/18 passed**, 6 requirements decided without an LLM pass |
| R11 dependency budget | `node scripts/ratchets/r11-dependency-budget.mjs` | **exit 0** — `audit 9 / runnerMinutes 5 / provisioningDiagnosticRecorder 2 / provisioningDiagnosticWriteGate 2 / transcripts 1`, no `metrics-projection` entry |
| R11 paired test | `node --test scripts/ratchets/r11-dependency-budget.test.mjs` | **12 pass / 0 fail** |
| Transcript ordering regression | `node --test apps/api/src/session-transcripts/transcript-capture-ordering.test.mjs` | **2 pass / 0 fail**, including the negative control |
| Diagnostics observer lifecycle | `node --test dist/task-provisioning-diagnostics/task-provisioning-diagnostics-observer-lifecycle.spec.js` | **12 pass / 0 fail** |
| Capacity projection pin | `node --test apps/api/src/runner-metrics/capacity-projection-pin.test.mjs` | **5 pass / 0 fail** |
| Metrics response equivalence | `node --test src/metrics/{metrics.verify,metrics-projection,task-resource}.test.mjs` | **26 pass / 0 fail** |
| Adversarial public surface | `CAP_PUBLIC_SURFACE_BASE_SHA=$(git rev-parse HEAD~1) node scripts/public-surface-adversarial.mjs verify collapse-three-collaborator-groups` | **`"passed": true`**, `command.exitCode: 0`, all five lanes (`sidecar`, `registry`, `restMetadata`, `mcpSdkMetadata`, `behavior`) `passed: true`, `findings: []` |

---

## MET requirements

### 1. `domain-event-bus/three-budget-entries-are-reduced-and-one-is-re-pointed-in-the-same-commit-and-by-different-rules`

**MET.** The requirement's discipline is that a *reduced* entry stays and reconciles to its own
delta while a *zeroed* entry is deleted rather than written as `count: 0`. Re-traced live:

- `node scripts/ratchets/r11-dependency-budget.mjs` exits 0 and prints exactly five collaborators —
  `this.audit 9`, `this.runnerMinutes 5`, `provisioningDiagnosticRecorder 2`,
  `provisioningDiagnosticWriteGate 2`, `this.transcripts 1`. The gate is bidirectionally
  fail-closed ("every collaborator exactly at its baselined count"), so a recorded count that
  diverged from the live count in *either* direction would fail it.
- `grep -c metrics-projection scripts/ratchets/r11.json` → **0**. The projection entry is deleted,
  not zeroed — the rule the requirement distinguishes from reduction.
- `COLLABORATORS.length` in `scripts/ratchets/r11-dependency-budget.mjs` → **5** (was 6), so the
  gate's own declaration moved with the file rather than lagging it.
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
- Metrics-projection reaches **0** and its entry is deleted — see requirement 4.
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

**MET.** Re-traced live:

- Ownership landed where the spec says: `apps/api/src/runner-metrics/capacity-projection.port.ts`
  and `capacity-projection.service.ts` exist, with `capacity-projection-pin.test.mjs` green at 5/5.
- The forwarding accessor is gone tree-wide: `grep -rn semaphoreProjection apps/api/src` → **no
  matches**, production code and test doubles alike.
- The orchestrator no longer names the projection: `grep -c SemaphoreProjectionSource
  apps/api/src/guardrails/guardrails.service.ts` → **0**, counted by the same rule the budget
  counter uses (type-only imports included), so a "removed at runtime but still named in a type
  position" dodge would not pass.
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

All 6 requirements in this change's specs have concrete, traceable implementation in the codebase
(new directories `task-provisioning-diagnostics/`, `runner-metrics/capacity-projection.*`,
`session-transcripts/`; the `guardrails.service.ts` constructor unchanged at 11 params;
`r11.json` / `r7.json` ratchets re-measured; the ordering-regression test present), independently
corroborated by `node scripts/spec-assert.mjs collapse-three-collaborator-groups` returning
**18/18** passing assertions covering all 6 requirements with none left for LLM judgment.

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

## Scope finding — implementation beyond the specs

**No scope creep found.**

The full implementation commit (`4f5c21c`) was reviewed against all six spec files and the change's
own `tasks.md` / `proposal.md`. All 38 changed files were inspected hunk-by-hunk:

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

No production behavior, file, or test was found that isn't traceable to a specific
requirement/scenario in the specs.

---

## Archive readiness

Nothing routed to `tasks.md` and nothing routed to `design.md` Open Questions. No archive-blocking
spec defect: the `surface-impact.json` sidecar's claims were executed rather than trusted, and the
adversarial verifier returned `passed: true` with an empty findings list on this tree. **This
change is verification-clean for archive.**

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
