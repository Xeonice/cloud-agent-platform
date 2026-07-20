## Context

BoxLite native execution exposes process settlement and command output through
different transports. `GET /executions/{id}` proves native state and exit code
but carries no stdout/stderr. WebSocket `/attach` carries stdout/stderr replay and
a terminal `exit` frame. BoxLite v0.9.5 retains bounded output backlogs, and a
live `vibe-zlyan` probe confirmed that attaching 150 ms after a fast process had
finished still replayed the full output before `exit`.

CAP starts attach and poll concurrently, but the diagnostics hardening change
introduced `finishAfterPoll()`: after poll settlement it waits one
`setImmediate`, closes a still-pending WebSocket, and merges the degraded
attach's empty strings into a successful numeric command result. This was meant
to avoid waiting a second full attach timeout, but it turns ordinary handshake
latency into fabricated empty output. Toolchain metadata is merely the first
consumer that exposes the bug; runtime setup, Git operations, delivery, trim,
transcript, and liveness commands all depend on the same executor contract.

The existing architecture imposes these constraints:

- orchestration and metadata readers remain provider-neutral;
- native poll remains authoritative for process terminal state and exit code;
- diagnostics remain bounded and must never contain commands, output, raw
  provider values, paths, endpoints, or secrets;
- process settlement must not incur a second full attach timeout;
- potentially side-effecting commands must never be rerun merely to recover
  output;
- Public V1, MCP, OpenAPI, API Playground, and persistent schemas do not change.

The first deployment canary proved the output-drain repair, then exposed a
second race in the same provisioning lifetime. BoxLite may return a successful
physical create response and invoke `onSandboxCreateObserved` before its
provider-level `provision()` promise returns. The provider-center currently
persists legacy ownership only after that promise resolves. If a terminal stop
wins in between, cleanup sees no owner row and manufactures `already-absent`
without consulting BoxLite. The late provider continuation can therefore leave
the exact box running, while Guardrails logs `provision_failed` even though the
task's cancelled terminal state correctly wins its database compare-and-set.

## Goals / Non-Goals

**Goals:**

- Make successful provider-neutral command results mean that both process and
  promised output settlement are complete.
- Capture BoxLite late-attach replay deterministically under one command-level
  deadline.
- Preserve process truth separately when output capture fails, while failing
  closed at the output-dependent executor boundary.
- Keep cancellation, timeouts, resource cleanup, diagnostics, and test behavior
  bounded and deterministic.
- Prove the fix with fake-transport race tests, provider conformance, repeated
  fast commands, real BoxLite E2E, and a final deployment canary.
- Close the provider-create/owner-persistence window so terminal cleanup always
  has either an exact observed sandbox id or provider-backed absence evidence.
- Preserve the first terminal winner across task state, diagnostics, audit, and
  cleanup-attempt settlement.

**Non-Goals:**

- Adding a metadata-specific Files API fallback or changing Gitee clone/auth.
- Adding an `outputComplete` field to every provider result in this change.
- Retrying native commands after output loss.
- Adding a new public diagnostic cause, API operation, MCP tool, database field,
  or user-facing task schema.
- Upgrading BoxLite or adding a new BoxLite output endpoint.
- Redesigning guest-process kill semantics or increasing general command-output
  retention limits.

## Decisions

### 1. Treat process settlement and output settlement as independent facts

The BoxLite execution joins two state machines:

```text
process: POST -> polling -------------------------> terminal(native state, exit)
output:          connecting -> replay/streaming --> drained(attach exit)
                                \-----------------> degraded / timed out

successful normalized result = process terminal + output drained
```

Poll decides how the guest process ended. The attach `exit` frame decides that
all promised stdout/stderr preceding it has been drained. A command that emits
no bytes is valid only when both facts are present; an empty buffer from a
connecting or failed socket is not output settlement.

`SandboxCommandExecutionResult` remains unchanged. Its existing
`output/stdout/stderr` fields continue to imply completeness on success. If
BoxLite cannot prove output completion, its adapter raises a typed internal
transport/protocol/timeout settlement error after recording the separate safe
process and attach facts. Existing command classification maps that error to
`transport_failed`, `protocol_failed`, or `settlement_unknown`; the change does
not add a public diagnostic discriminator.

Alternative considered: add `outputStatus` to every successful result and make
each consumer remember to reject partial output. That creates a wider migration
and preserves the dangerous possibility that an unchecked consumer parses
partial data. Fail-closed success semantics are smaller and safer.

### 2. Join poll and attach under one absolute deadline

The client calculates one monotonic `deadlineAt` when native execution begins.
Execution start, polling, attach handshake/replay, and terminal joining consume
that budget. Poll and attach start as soon as the execution id exists and run
concurrently:

- if poll settles first, attach continues with `deadlineAt - now` and consumes
  late replay through its `exit` frame;
- if attach drains first, poll continues with the same remaining budget because
  the WebSocket exit does not replace authoritative process settlement;
- if attach fails first, polling may continue within the same budget to retain a
  safe process fact, but the executor cannot return a successful output result;
- if poll cannot establish process settlement, the client closes attach and
  returns the existing typed process failure;
- cancellation closes observation transports, clears timers/listeners, and
  follows the existing guest-process fencing behavior.

Every terminal path owns explicit cleanup for the WebSocket, timers, decoders,
and AbortSignal listener. The implementation must not resolve on an arbitrary
event-loop turn and must not allocate a new full timeout after either channel
settles.

Alternative considered: wait a fixed 50-500 ms after poll. That is neither a
protocol terminal condition nor stable under network and machine load. Restoring
the previous two independent full timeouts would be deterministic but violates
the bounded completion requirement.

### 3. Use the native attach terminal frame as the output-drain barrier

The attach collector maintains explicit `connecting`, `streaming`, `drained`,
`degraded`, and `timed_out` outcomes. It preserves separate UTF-8 decoders for
stdout and stderr, drains fragmented binary frames in arrival order, flushes
decoders only at a terminal outcome, and retains the attach exit code. Receipt
of `exit` completes output settlement; ordinary socket close before `exit`,
constructor error, transport error, malformed control data, and deadline expiry
do not.

After both channels settle, the client verifies that attach and poll exit codes
agree. A mismatch is a typed protocol failure. Only a drained attach is eligible
for `mergeExecOutput`; degraded or timed-out attach results cannot fall through
to polled empty strings. Reconnecting attach to consume supported backlog replay
is allowed if it remains inside the same execution and deadline, but rerunning
`POST /exec` is forbidden.

Alternative considered: redirect every command to a temporary file and read it
later. That changes command semantics, cleanup, disk use, and secret exposure,
and still does not generalize to all provider protocols.

### 4. Preserve bounded diagnostics without changing public schemas

`native_exec_poll` continues to emit the authoritative process settlement.
`native_exec_attach` reports succeeded only after the output terminal marker;
error, early close, or deadline emits one degraded/timed-out summary using the
existing safe cause vocabulary. The consuming runtime/workspace operation then
uses its existing classified safe transport/protocol/settlement failure.

This permits diagnostics to represent all three facts without contradiction:

```text
process settlement: succeeded, nativeState=completed, exitCode=0
output settlement:  degraded, cause=transport_failed|settlement_unknown
consumer operation: failed with the matching existing safe classification
```

No diagnostic schema, Public V1/MCP projection, raw log field, or per-frame/
per-poll event is added. Unique canaries prove that commands, output, sandbox and
execution ids, endpoints, paths, provider errors, and credentials remain absent.

Alternative considered: classify the entire operation as `command_failed`.
That would falsely claim a non-zero guest exit and erase the proven process fact.

### 5. Make real protocol behavior part of conformance

Fake WebSocket tests will expose deterministic handshake and frame controls
rather than ordering both sides with the same `setImmediate`. Conformance covers
poll-first, attach-first, valid empty output, fragmented stdout/stderr and UTF-8,
non-zero exit, early close/error, hang, deadline, cancellation, and exit-code
mismatch. A repeated fast-command story amplifies the original race.

The gated BoxLite E2E adds fast `printf` and toolchain metadata reads in native
mode. A deployment canary cloned from the failed task configuration is the final
rollout check, but it does not replace infrastructure-free tests or local real
provider E2E.

Alternative considered: rely only on the remote canary. It is useful rollout
evidence but combines provider, host load, forge networking, and credentials,
making it unsuitable as the deterministic regression gate.

### 6. Fence every legacy provider invocation before it can create

Provider-center SHALL reuse the existing internal `sandbox_runs.create_state`
protocol for legacy provisioning, without adding a database column or exposing
new wire state. Before invoking the selected provider, CAP atomically inserts
one ownerless legacy row in `entered` state. An existing row cannot be borrowed
by another replica, so one durable pre-call fence identifies one invocation.
Immediately before every external physical-create boundary, provider-center
revalidates that the same row remains `provisioning + entered`; a terminal
winner that changed it to `deleting` therefore prevents later create I/O.
After publishing the ownerless fence and before invoking the selected provider,
the Router also re-runs the upstream Task lifecycle guard. This closes the
interval in which another replica could commit terminal state while no owner row
was yet visible, and protects compatibility providers that never invoke the
create-boundary callback themselves. Callback-aware providers repeat the same
idempotent guard immediately before their physical create.

When the provider observes a definitive create response, it compare-and-sets
the exact provider sandbox id onto that still-live row before initialization
continues. Compatibility providers that do not emit create callbacks must pass
the same observation CAS after `provider.provision()` returns and before owner
promotion. The final running-owner write is conditional on the same row still
being live and back in `idle` state. A terminal cleanup that has already fenced
or settled the row therefore prevents both callback-aware and generic success
paths from recreating ownership. If observation or completion loses that race,
the provider's existing partial-create cleanup deletes the exact resource and
the router preserves cleanup as secondary evidence.

For an `entered` terminal race, cleanup first performs a provider-backed probe,
then joins the same-process provider invocation for a bounded interval. It may
atomically close `entered` to `idle` only after that invocation has settled and
a post-invocation teardown proves the task-derived or exact target absent. A
join timeout, crashed/unknown invocation, or unconfirmed teardown remains
`deleting + pending`; it never becomes synthetic success. Ordinary legacy rows
whose create state is already `idle` retain the existing one-shot legacy
settlement and do not manufacture a durable cleanup owner.

This is an internal persistence protocol, not a durable-ownership migration:
legacy rows retain null owner/resource generations, the current schema and
retention behavior remain valid, and provider implementations keep their
existing normalized contract.

Alternative considered: record ownership only after `provision()` returns and
teach `stop()` to retry later. That still leaves an unbounded period with no
authoritative resource identity, relies on timing, and permits a late success
write to resurrect a terminal task.

### 7. Physical cleanup evidence, not owner-row absence, proves cleanup

The absence of a legacy owner row is not evidence that no provider resource was
created. When cleanup cannot resolve an owner, provider-center SHALL execute the
registered providers' normalized teardown/absence checks for the task and
aggregate their real outcomes. It SHALL report cleanup succeeded only when all
eligible providers prove deletion or absence; indeterminate or failed probes
remain truthful cleanup failures. When an observed owner exists, cleanup uses
its provider and exact provider sandbox id.

This fallback also repairs pre-change gaps and crash windows without a public
task-cleanup API. It does not guess a BoxLite id, inspect provider internals, or
introduce a BoxLite branch into Guardrails.

Alternative considered: keep returning synthetic `already-absent` for a
missing owner. The canary disproved that inference, so retaining it would make
both resource safety and diagnostics knowingly false.

### 8. Cancellation remains the truthful terminal winner

After a provider promise settles, Guardrails rechecks the admission transition
token before emitting provider failure logs, force-failed audit, or diagnostic
primary failure. If stop/cancel already won, the continuation settles the
attempt as cancelled/superseded, records the real cleanup result, clears its
runtime admission state, and does not project a later provisioning failure onto
the terminal task.

This does not hide genuine failures: the provider failure path remains
unchanged while the running admission is still authoritative. It only aligns
structured logs, audit, attempt status, and task state around the same terminal
compare-and-set winner.

## Risks / Trade-offs

- **[Attach consumes the remaining command budget]** A command that settles near
  its deadline may fail output settlement even though the process exited zero.
  → This is the correct fail-closed result; tests cover the boundary and callers
  receive the existing safe timeout/settlement classification.
- **[Socket or listener leaks across races]** Concurrent terminal paths can each
  attempt cleanup. → Use one idempotent settlement/cleanup owner and assert timer,
  listener, and socket disposal for every injected race and cancellation phase.
- **[Tests silently disable native attach]** Injected fetch previously defaulted
  `nativeAttachOutput` off. → Native exec no longer exposes an attach-disabling
  seam; deterministic tests inject a controlled WebSocket transport and the
  real-provider gate verifies the same mandatory output-drain path.
- **[Output accumulation remains memory-bounded only by existing behavior]** The
  deployed server replay is bounded, while live streams can still be larger.
  → Do not increase retention in this change; retain existing behavior and track
  a future explicit client output-limit/cursor design separately.
- **[Typed output failure may reveal previously hidden errors]** Some commands
  that formerly appeared as successful empty output will now fail. → This is an
  intentional correctness fix; diagnostics preserve the process fact and the
  rollout canary verifies affected provisioning flows.
- **[Remote canary depends on external systems]** Forge or host failures may
  obscure the regression signal. → Require unit, conformance, stress, and real
  provider E2E first, then interpret remote diagnostics stage-by-stage.
- **[Terminal cleanup races a late create response]** Cleanup may first prove
  absence and then a provider may observe a just-created resource. → The
  unique pre-call fence is revalidated before create, rejects the late
  observation/promotion if terminal wins later, and BoxLite's partial-create
  handler deletes the exact returned id before the provider promise settles.
- **[Provider ignores cancellation or its process disappears]** Terminal cleanup
  cannot prove that an `entered` invocation has stopped merely from a local
  timeout. → Bound the local join, retain `deleting + pending`, and close the
  create fence only after provider settlement plus a final confirmed teardown;
  never release it from owner-row absence alone.
- **[Missing-owner fallback touches multiple providers]** A legacy task without
  ownership cannot identify a single provider. → Use the existing registered
  provider teardown fan-out, aggregate every outcome, and never infer success
  from an empty persistence lookup.
- **[A completion CAS can surface new cleanup work]** A provider may complete
  after cancellation already settled ownership. → Treat the CAS loss as a
  superseded create, invoke exact partial cleanup, and retain the original
  terminal task state.

## Migration Plan

1. Add provider-neutral success semantics and conformance cases without changing
   the result wire shape or diagnostic enums.
2. Refactor BoxLite attach/poll joining and typed failure handling, then update
   the tests that currently expect poll success to close an incomplete attach.
3. Run focused BoxLite tests, full sandbox tests and coverage, strict OpenSpec
   validation, and gated native BoxLite E2E.
4. Add legacy create-boundary fencing, observed-id compare-and-set, provider-
   backed no-owner cleanup, and terminal-winner settlement with deterministic
   interleaving tests.
5. Deploy the resulting release to a canary environment, create a task matching
   the failed `vibe-zlyan` configuration, and verify metadata preflight advances
   into workspace/Git provisioning with bounded diagnostics; cancel during
   physical creation and prove the exact sandbox is absent afterward.
6. Roll out normally once the canary passes. No database, API-client, MCP,
   OpenAPI, or Playground migration is required.

Rollback is a normal image/code rollback because no persistent schema changes
exist. A rollback restores the earlier race and is therefore only an emergency
operational action; it does not require data repair.

## Open Questions

No blocking design question remains for implementation. Separate follow-up work
may evaluate a provider-neutral output-size limit/cursor contract and a BoxLite
version upgrade, but neither is required to correct the verified v0.9.5 race.
