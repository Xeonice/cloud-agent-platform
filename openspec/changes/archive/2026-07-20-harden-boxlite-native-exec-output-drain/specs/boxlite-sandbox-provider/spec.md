## MODIFIED Requirements

### Requirement: BoxLite command and archive operations normalize to CAP contracts

The BoxLite provider SHALL expose command execution and archive/file transfer
through CAP's provider-neutral executor and workspace descriptors. Command
execution SHALL normalize exit code, stdout/stderr, timeout, working directory,
native terminal state, and error shape so runtime setup, preflight, delivery,
trim, transcript capture, and liveness checks do not depend on BoxLite-specific
response formats. A successful result SHALL require affirmative native success,
a successful exit-code settlement, and complete settlement of every output
source promised by the normalized result. Native `failed` or `killed` states
SHALL always normalize as a typed failure; when their exit code is absent, the
native parser SHALL retain null and diagnostics SHALL record the missing-exit
anomaly. Before adapting to the existing provider-neutral command result whose
exit code remains numeric, BoxLite SHALL throw a typed settlement failure rather
than fabricating zero/one or widening every provider's result. Only a response
without terminal proof is indeterminate. Malformed responses, poll timeout, and
transport loss SHALL retain distinct safe normalized outcomes.

For the native protocol, polling SHALL remain authoritative for process terminal
state and exit code, while the attach stream's terminal `exit` frame SHALL be
authoritative for complete stdout/stderr drain. Process settlement SHALL NOT
prove output completeness, including when polling reports completed with exit
code zero. CAP SHALL start polling and attach concurrently and SHALL join both
channels under one absolute command deadline. When polling settles first, CAP
SHALL keep or establish attach long enough to consume BoxLite's bounded replay
through its terminal output marker using only the deadline's remaining budget.
It SHALL NOT close attach merely because polling settled, because one event-loop
turn elapsed, or by starting a second full attach timeout.

An attach operation SHALL use an explicit success/degraded/timed-out result
rather than overloading null as both no output and transport failure. Attach
failure SHALL remain distinct from the process result: it SHALL NOT rewrite a
proven native state or exit code, but it SHALL prevent a successful normalized
executor result whose output completeness cannot be proven. The executor SHALL
raise a typed output-unavailable or protocol outcome rather than returning
fabricated empty output, and it SHALL NOT rerun the command to recover missing
output. A zero-byte stdout/stderr result SHALL be accepted only after the attach
terminal marker proves the streams were drained. Conflicting poll and attach
exit codes SHALL fail closed as a typed protocol inconsistency.

Normalized executor results MAY carry output for their existing in-process
consumer, but diagnostic events, logs, persistence, REST, and MCP MUST NOT carry
that output or the command that produced it.

#### Scenario: Command execution returns normalized results

- **WHEN** CAP runs a setup or preflight command through the BoxLite executor and both process and output settlement complete
- **THEN** the result carries a normalized exit code and complete output text independent of the BoxLite client response shape

#### Scenario: Failed native state without exit code is never success

- **WHEN** BoxLite reports a native execution state of `failed` or `killed` without an exit code
- **THEN** the native parser records a failed result with null exit code and the adapter raises a typed settlement failure
- **AND** it never substitutes exit code zero or reports success

#### Scenario: Fast native execution drains late attach replay

- **WHEN** polling proves a fast native command completed before attach finishes its handshake
- **THEN** CAP consumes the late attach replay through its terminal `exit` frame within the original command deadline
- **AND** it returns the complete stdout/stderr without a fixed post-poll sleep

#### Scenario: Empty output requires completion proof

- **WHEN** a native command produces zero bytes and both poll and attach reach their terminal states
- **THEN** CAP returns a valid empty normalized output
- **AND** it distinguishes that result from an attach that failed before proving output drain

#### Scenario: Attach degradation preserves process truth but fails incomplete output

- **WHEN** attach errors, closes, or reaches the shared deadline before its terminal output marker while polling proves the process terminal state
- **THEN** diagnostics preserve the proven native state and exit code and report attach degradation separately
- **AND** the normalized executor call fails with a typed output-unavailable outcome rather than returning successful empty output
- **AND** CAP does not rerun the command

#### Scenario: Independent settlement channels share one deadline

- **WHEN** either polling or attach settles before the other channel
- **THEN** CAP waits for the remaining required terminal fact using only the original command deadline's remaining budget
- **AND** it does not begin a second full timeout after either channel settles

#### Scenario: Conflicting settlement channels fail closed

- **WHEN** polling and attach report different exit codes for the same execution
- **THEN** CAP raises a typed protocol inconsistency and records only bounded safe diagnostic facts
- **AND** it does not choose one code silently or return a successful normalized result

#### Scenario: Poll timeout remains distinguishable

- **WHEN** BoxLite cannot prove native execution settlement before its deadline
- **THEN** the executor returns a timeout or indeterminate normalized failure
- **AND** it does not infer success from an absent exit code or incomplete response

#### Scenario: Workspace materialization can upload an archive

- **WHEN** CAP materializes a workspace into a BoxLite sandbox via archive transfer
- **THEN** the provider uploads and extracts the archive at the selected workspace path without exposing provider-specific file APIs to orchestration code

#### Scenario: Workspace sync can download an archive

- **WHEN** CAP needs to capture or sync provider workspace files from BoxLite
- **THEN** the provider downloads an archive through the workspace descriptor and CAP consumes it through the provider-neutral workspace bridge

### Requirement: BoxLite cleanup preserves and follows the primary provisioning outcome

The BoxLite provider SHALL preserve the primary failure, execute bounded
cleanup, and report cleanup as an independent outcome when provisioning fails
after a box may have been created. A cleanup exception MUST NOT replace the
primary failure. Delete success SHALL require confirmed sandbox absence.
BoxLite internal partial-create cleanup and provider-center fallback teardown
SHALL share one cleanup lineage and remain idempotent.

For task-scoped legacy provisioning, CAP SHALL persist the selected BoxLite
provider and unique invocation fence before calling its provision path, SHALL
revalidate that fence immediately before crossing `POST /boxes`, and SHALL
persist the definitive box id from the create response before runtime setup or
workspace materialization may continue. If cancellation or cleanup wins that
race, boundary validation or the observation callback SHALL fail closed so the
partial-create handler removes the exact returned box. Cleanup invoked without
an observed id SHALL still probe/delete BoxLite's deterministic task-scoped id
and confirm physical absence after the invocation settles; a missing CAP owner
record or an expired local join is not cleanup proof.

#### Scenario: Cancellation after physical create removes the exact box

- **WHEN** BoxLite creates a box and task cancellation wins before provider provisioning returns
- **THEN** CAP records or consumes the definitive box id and confirms that exact box is removed
- **AND** runtime setup, workspace materialization, and agent launch do not continue as an authoritative task path

#### Scenario: Cancellation before create acknowledgement remains fail closed

- **WHEN** cancellation occurs after the create boundary while the BoxLite response is unresolved
- **THEN** the provider request is cancelled and provider-center performs a real deterministic-id teardown/absence check after settlement
- **AND** a late successful response is handled as a partial create and removed rather than exposed as running
