## Incident evidence

The `vibe-zlyan` task `573f01af-e52b-4ddc-960c-4d18ba671994` and an independently
created task with the same configuration both failed during `runtime_preflight`
before workspace transfer or Git clone began. BoxLite create and start succeeded,
native execution polling proved `completed` with exit code zero, native attach
degraded before delivering output, and the metadata reader then attempted to
parse an empty string.

A direct BoxLite Files API read proved that `/etc/cap/sandbox-metadata.json` was
present, valid, and declared the expected Codex and gcode dependencies. The
metadata image, Gitee credential, repository URL, and clone implementation are
therefore downstream of the observed failure rather than its cause.

## Live protocol proof

The deployed BoxLite service is version `0.9.5`. A read-only protocol probe
started a fast `printf`, deliberately waited 150 ms for the process to finish,
then attached over the native WebSocket endpoint. BoxLite replayed the complete
marker and emitted an `exit` frame with exit code zero. This proves that late
attach replay is available on the deployed version and that CAP does not need a
fixed sleep, a metadata-specific Files API bypass, or a BoxLite protocol upgrade
to recover fast-command output.

The upstream v0.9.5 protocol and implementation establish the same boundary:

- `POST /exec` creates an execution and `GET /executions/{id}` reports process
  status and exit code, but not stdout or stderr.
- WebSocket `/attach` is the output transport and emits the output stream plus
  the terminal `exit` frame.
- Late attach drains bounded stdout/stderr backlogs before emitting `exit`.
- The official REST SDK composes execution start, attach, and wait rather than
  treating poll completion as output completion.

Sources:

- https://github.com/boxlite-ai/boxlite/blob/v0.9.5/openapi/box.openapi.yaml#L519-L656
- https://github.com/boxlite-ai/boxlite/blob/v0.9.5/src/cli/src/commands/serve/handlers/executions.rs#L239-L515
- https://github.com/boxlite-ai/boxlite/blob/v0.9.5/src/cli/src/commands/serve/mod.rs#L124-L224
- https://github.com/boxlite-ai/boxlite/blob/v0.9.5/src/boxlite/src/rest/litebox.rs#L86-L132

## Current implementation map

- `packages/sandbox-provider-boxlite/src/boxlite-client.ts` starts native exec,
  starts attach, and polls concurrently. After poll settlement it calls
  `finishAfterPoll()`, which currently waits only one `setImmediate`, closes the
  WebSocket, and converts a still-connecting attach into degraded empty output.
- `packages/sandbox/src/host-harness/configured-provider.ts` consumes the
  provider-neutral command output to parse toolchain metadata. It correctly
  fails on the fabricated empty result and must remain provider-neutral.
- `packages/sandbox-core/src/command-executor.ts` defines a successful command
  result with normalized exit code and stdout/stderr/output. It has no contract
  under which an incomplete output stream may be returned as a successful empty
  result.
- `packages/sandbox-provider-boxlite/test/boxlite-diagnostics.test.mjs` currently
  codifies the regression by requiring poll settlement to close a hanging attach
  within 250 ms even when the command timeout is five seconds.

Git history shows that the first native attach implementation waited for its
already-running output promise after poll settlement. The provisioning
diagnostics change replaced that behavior with `finishAfterPoll()` to satisfy a
valid requirement that command completion must not incur a second full attach
timeout, but the one-event-loop shortcut introduced a real handshake race.

## Existing specification boundary

The current `boxlite-sandbox-provider` requirement correctly makes native poll
authoritative for process status and exit code, but incorrectly allows degraded
attach to coexist with a successful normalized command result even when attach
is the only output source. The current observability scenario repeats that
ambiguity by calling poll settlement the successful execution outcome.

The previous diagnostics change also correctly requires bounded diagnostic
events, forbids commands and output from logs or persistence, and forbids a
second full timeout after process settlement. The new change must preserve all
three properties while separating these facts:

```text
process settlement = completed / exit 0
output settlement  = complete | unavailable
consumer outcome   = success only when required output is complete
```

## Recommended architecture

1. Keep native poll authoritative for process terminal state and exit code.
2. Make attach `exit` authoritative for complete stdout/stderr drain, including
   the valid zero-byte-output case.
3. Start poll and attach concurrently and join both under one absolute command
   deadline. Poll settlement must not close attach merely because one event-loop
   turn elapsed, and output drain must not start a second full timeout.
4. If attach errors, closes, or reaches the shared deadline before output
   completion, preserve the proven process fact for diagnostics but fail the
   normalized executor call with a typed output-unavailable/protocol outcome.
   Never fabricate empty output and never rerun a possibly side-effecting
   command to recover output.
5. Keep the fix inside the provider and provider-neutral conformance boundary.
   Metadata, runtime setup, task orchestration, Public V1, MCP, OpenAPI, and API
   Playground retain their existing contracts.
6. Retain bounded, secret-free diagnostics: no poll tick, attach frame, command,
   stdout/stderr, provider id, path, endpoint, or raw error may be recorded.

## Rejected alternatives

- A fixed 50-500 ms post-poll sleep remains load- and network-dependent and
  converts a correctness condition into a probabilistic delay.
- Reading only toolchain metadata through the Files API leaves every other
  output-dependent command vulnerable and leaks provider mechanics into the
  host harness.
- Retrying the command can duplicate side effects after process success.
- Upgrading BoxLite alone cannot correct CAP closing a valid replay connection
  before its protocol terminal frame.
- Restoring two independent full timeouts violates the diagnostics change's
  bounded-completion requirement.

## Verification focus

- Deterministic unit tests where poll settles before delayed attach handshake,
  attach settles before poll, output is fragmented across stdout/stderr frames,
  UTF-8 spans frames, and a proven empty stream returns an empty result.
- Failure tests for attach error/early close/hang, shared-deadline exhaustion,
  poll transport failure, cancellation at each phase, and conflicting poll/
  attach exit codes. None may return successful fabricated output or rerun the
  command.
- Diagnostic assertions for bounded start/terminal events and absence of unique
  command, output, credential, provider-id, and raw-error canaries.
- Repeated fast-command stress plus the real BoxLite provider E2E against the
  supported native protocol.
- A final `vibe-zlyan` canary using the failed task configuration, proving
  runtime metadata preflight advances into workspace/Git provisioning and that
  the probe sandbox is cleaned up.
