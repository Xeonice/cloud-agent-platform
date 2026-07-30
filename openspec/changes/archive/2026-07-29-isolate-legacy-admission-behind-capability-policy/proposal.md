## Why

When a deployment cannot prove the `task-admission-v2` capability, every task it
accepts silently runs down a second, older admission pipeline. That decision is
one anonymous ternary in `tasks.service.ts:1113` which flattens a ten-valued gate
result — and a missing gate provider, which has no reason at all — into a boolean.
Nothing downstream can state *why* a task took the path it took, the alternative
consequence (refuse rather than degrade) cannot be expressed without editing call
sites, and the ~750 lines implementing the legacy pipeline have no boundary of
their own: they are interleaved with the durable pipeline inside a single
3,906-line class, distinguishable only by method naming.

This is the first step of retiring the legacy pipeline. It makes the degradation
decision explicit and gives the legacy pipeline a physical home, so that the
deployment-side questions blocking retirement (cap-rest capability, two-stage
rollout, attestation renewal) can each be evaluated and scheduled independently
instead of as one undifferentiated risk.

## What Changes

- **A named admission-mode policy replaces the ternary.** The gate result is
  carried, not flattened: choosing the mode becomes a single explicit decision
  that records which capability was unproven and why. An absent gate provider
  becomes a distinct, named outcome rather than silently indistinguishable from a
  closed gate.
- **The legacy admission pipeline is extracted behind that policy.** The 347-line
  provisioning block inside `startRunningAfterCapacity`, the twelve helpers around
  it, and the six process-local state containers they share move out of
  `GuardrailsService` into their own directory, reached through an explicit port.
  Everything the pipeline still needs from the orchestrator is named on that port
  rather than reached implicitly through `this.`.
- **The consequence itself does not change.** An unproven capability still
  degrades to legacy, with identical observable behaviour. The policy has one
  registered outcome; the refusal outcome becomes *expressible*, not enabled.
- **The legacy path becomes countable.** Because the policy is a total mapping
  over the gate's closed reasons, adding a reason without deciding its consequence
  stops compiling.

Not breaking: no HTTP, MCP, database, or environment-variable surface changes.

## Capabilities

### New Capabilities

None. The behaviour being made explicit already belongs to `guardrails`; naming
it as a separate capability would split one admission story across two specs.

### Modified Capabilities

- `guardrails`: admission-mode selection becomes an explicit, reason-carrying
  policy over the deployment-capability gate rather than an implicit boolean
  fallback, and the legacy admission pipeline is required to sit behind a declared
  port rather than inside the guardrails orchestrator.

## Impact

**Code**

- `apps/api/src/tasks/tasks.service.ts` — the decision point moves behind the
  policy; `PreparedTaskCreate` continues to carry a frozen mode.
- `apps/api/src/task-admission/` — the gate gains a reason-carrying read; the
  existing `GET /deployment-capabilities/task-admission-v2` response is unchanged.
- `apps/api/src/guardrails/guardrails.service.ts` — 4,539 → 3,807 lines (−732).
  What remains of the coupling is an 18-member port the extracted directory
  declares, plus a 10-member entry surface the orchestrator calls.
- A new concern-named directory for the legacy pipeline, subject to
  `scripts/api-module-layout-check.mjs` (`ALLOWED_CYCLES` is empty and must stay
  empty).

**Tests** — 122 existing guardrails tests (83.9% line / 81.4% branch coverage of
the service, with the extracted block executed 50 times) are the behavioural
contract; they must stay green without being rewritten to match the new shape.

**Not affected** — no active change touches `guardrails`; the four deployment
modes, the attestation format, and the two-stage rollout procedure are untouched.

**Non-Goals** (each is a prerequisite for retirement, deliberately deferred so it
can be decided on its own evidence):

1. Deciding whether an unproven capability should refuse rather than degrade.
2. Giving BoxLite `cap-rest` a way to prove `disk_size_gb`/rootfs enforcement, or
   declaring that mode unsupported for task execution.
3. Automating attestation renewal so expiry becomes an exception rather than a
   routine state, and reworking the two-stage rollout so stage one need not admit
   tasks through the legacy pipeline.
4. Deleting the legacy pipeline. That is the last step, not this one.
