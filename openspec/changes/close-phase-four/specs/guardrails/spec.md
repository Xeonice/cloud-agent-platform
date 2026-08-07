## ADDED Requirements

### Requirement: Phase 4's acceptance record states measured values and names what it defers

Every phase-4 acceptance criterion in `docs/refactor-master-plan.md` SHALL state a NUMBER that was
measured, or name the phase it is deferred to and why. A criterion phrased as "降到裁定值" without the
value cannot be passed or failed by anyone who reads it, and a criterion silently left unmet reads as
an oversight rather than a decision.

Criterion (c) SHALL record **7** as the phase-4 floor for
`cross-context-import:apps/api/src/guardrails/guardrails.service.ts`, together with the reason the
floor is where it is: the seven surviving imports are calls and types with return values, and this
plan's own non-event criterion (`docs/refactor-master-plan.md:133-135` — "订阅者需要向发布者返回确认
的，是调用不是事件") puts them structurally out of reach of phase 4's mechanism. They are retired by a
DIFFERENT mechanism named in the ratchet entry itself — the owning context exporting an explicit
`*.port.ts` — which belongs to phases 5-6. Recording only the number would leave the next author
trying to burn it down with the wrong tool.

Criterion (b) SHALL be recorded as DEFERRED TO PHASE 6, by decision, with the measurement that
motivated the deferral rather than a bare pointer. Of the six subsystems the orchestrator constructs,
five are its own mechanisms by every instrument the repository owns — same directory, same context,
sole production importer, absent from `COLLABORATORS`, absent from r7. The sixth,
`TaskProvisioningDiagnosticsObserverLifecycle`, IS owned by another context and has a DI seam already
built, but it is constructed locally on purpose: the comment above it states that the frozen
out-of-directory specs and the wired application must share ONE construction path rather than
splitting into a DI path and a test path. Injecting it would undo that, and phase 6 — directory
consolidation and layout v2 — is where construction paths and directory ownership move together.

A number this plan states and measurement later refutes SHALL be corrected AT THE STATEMENT, with the
refutation kept rather than erased. Two such numbers stand today at `docs/refactor-master-plan.md:146`:
the runner-billing floor is recorded as 5 and measures **4** (the legacy retirement took one further
`recordStart` with the method that held it), and the diagnostics group is recorded as reaching 2 after
that retirement and measures **4** (2 recorder + 2 write gate — the orchestrator's single read of the
pair fed two consumers, and only one of them left). The second is the prediction
`retire-legacy-inline-admission` already corrected in the live spec and in `scripts/ratchets/r11.json`
and did not correct here, which is exactly how one number stays true in one place and false in another.

#### Scenario: Every phase-4 criterion can be passed or failed by reading it

- **WHEN** the phase-4 acceptance table is read
- **THEN** each row states either a measured number with the command that produced it, or the phase it
  is deferred to and the measurement behind that decision

#### Scenario: The deferred criterion is a decision on the record

- **WHEN** criterion (b) is read
- **THEN** it says it is deferred to phase 6, says five of six constructions are not cross-cutting by
  the repository's own instruments, and says the sixth is constructed locally to keep one construction
  path — so a later reader can disagree with the decision rather than mistake it for an omission

#### Scenario: The refuted numbers are corrected where they were stated

- **WHEN** `docs/refactor-master-plan.md:146` is read
- **THEN** the runner-billing floor reads 4 and the post-retirement diagnostics floor reads 4, each
  carrying the measurement that refuted the earlier figure rather than replacing it silently
