## ADDED Requirements

### Requirement: AgentRuntime owns validated per-task model launch policy

The `AgentRuntime` port SHALL receive a discriminated persisted model intent in
every task launch-context variant and call site, distinguishing runtime default
from an explicit selector without using lookup failure as default intent. Codex
and Claude Code runtime policies SHALL apply an
explicit validated selector to both interactive-PTY and headless-exec new
session launch commands using the runtime's model argument. Argument
construction SHALL use the shared shell-safe quoting mechanism and SHALL remain
safe for valid punctuation-bearing model ids. Shared sandbox providers,
terminal clients, and provisioning scaffolding SHALL remain runtime-agnostic
and SHALL NOT branch on Codex or Claude model semantics. An explicit task model
SHALL take precedence over any effective credential-level configured default;
when the task model is absent, existing credential/CLI default behavior SHALL
remain in control.

#### Scenario: Codex receives an explicit model in either execution mode

- **WHEN** a new Codex task has a validated requested model and starts in interactive-PTY or headless-exec mode
- **THEN** the Codex runtime launch command contains that exact selector as one safely quoted model argument

#### Scenario: Claude Code receives an explicit model in either execution mode

- **WHEN** a new Claude Code task has a validated requested model and starts in interactive-PTY or headless-exec mode
- **THEN** the Claude Code runtime launch command contains that exact selector as one safely quoted model argument

#### Scenario: Malicious shell text cannot escape the model argument

- **WHEN** a syntactically accepted provider-qualified model id contains shell-significant punctuation
- **THEN** launch construction treats the full selector as one argument
- **AND** no fragment is executed as shell syntax

#### Scenario: Task selector overrides a credential default

- **WHEN** the effective credential config has a default model and the Task has a different validated explicit selector
- **THEN** the runtime launches with the Task selector as the per-run override

### Requirement: Model validation and launch use the same task-owned credential context

The system SHALL resolve the credential and policy used to catalog, validate,
and launch an explicit model from the authenticated owner id before Task
creation and from the persisted Task owner during provisioning/recovery. Runtime
adapters SHALL NOT use an unscoped first credential or another owner's global
credential. Unsupported stored credential modes SHALL remain unavailable until
the runtime implements their secure injection path.

#### Scenario: Two Claude owners remain isolated

- **WHEN** two owners have different Claude credentials or model policies and each starts a task
- **THEN** each task's catalog validation and runtime launch use only that task owner's credential context

#### Scenario: Preflight resolves owner before a Task exists

- **WHEN** an authenticated owner requests a catalog or validates a create body before any Task row exists
- **THEN** the credential port resolves from that explicit authenticated owner id rather than requiring a task id

#### Scenario: Unsupported credential injection fails closed

- **WHEN** an owner selected a credential mode the runtime does not implement for task execution
- **THEN** catalog and task preflight fail with safe readiness semantics
- **AND** the runtime does not fall back to another account's credential or a process-global credential

### Requirement: Omitted and recovered models preserve deterministic runtime behavior

When `Task.model` is null, each runtime SHALL emit the same launch behavior as
before this capability and allow its effective account/CLI default to decide.
Recovery or reattachment of an already-created task SHALL use the persisted
launch intent and SHALL NOT switch models based on a newly refreshed catalog.
Changing a model on an existing runtime session is outside this capability.

#### Scenario: Omission leaves launch behavior unchanged

- **WHEN** a Codex or Claude Code task omits `model`
- **THEN** the generated setup and launch behavior is byte-equivalent to the pre-feature path with no model argument added

#### Scenario: Existing task recovery does not select a new model

- **WHEN** CAP recovers admission or reconnects to a task after its catalog context has changed
- **THEN** it retains the persisted requested model and existing session identity
- **AND** it does not validate or substitute a newly listed model during recovery

### Requirement: Runtime observation records actual model without rewriting intent

The runtime SHALL preserve an actual model reported by its transcript or
structured event in session-history metadata independently of
`Task.model`. A detected mismatch between an explicit request and an actual
reported model SHALL be observable through safe diagnostics and response/UI
facts; lack of an actual-model report SHALL remain unknown rather than inferred
from the request.

#### Scenario: Actual model is reported independently

- **WHEN** the runtime emits an actual model in its transcript metadata
- **THEN** session history records the emitted value even if the task requested an alias

#### Scenario: Runtime does not report an actual model

- **WHEN** no trustworthy runtime event identifies the actual model
- **THEN** actual-model metadata remains absent
- **AND** CAP does not copy `Task.model` into that field as fabricated evidence

### Requirement: Runtime model launch rejection is a structured task failure

The runtime SHALL classify a CLI rejection of an explicit model after
successful preflight as stable task failure `runtime_model_rejected` only when
the pinned runtime adapter receives trustworthy structured evidence or a stable
version-checked CLI error code dedicated to model rejection. It SHALL attach a
safe choose-another-model recovery action and transition through the canonical
task failure path. Unstructured text, generic non-zero exit, authentication,
network, quota, or process failures SHALL remain under their existing accurate
failure classifications; they SHALL NOT be guessed as model rejection. The
runtime SHALL NOT silently remove the model argument, retry with a different
model, or expose raw CLI/provider diagnostics as the public failure.

#### Scenario: Structured CLI evidence rejects a model after preflight

- **WHEN** an explicit selector passed catalog validation and the fresh runtime emits version-verified structured model-rejection evidence
- **THEN** the Task fails with `runtime_model_rejected` and an actionable choose-another-model hint
- **AND** its persisted requested model remains unchanged

#### Scenario: Generic runtime failure is not misclassified

- **WHEN** an explicit-model launch exits non-zero because of authentication, network, quota, crash, or only ambiguous text
- **THEN** the existing accurate failure classifier applies and `runtime_model_rejected` is not asserted

#### Scenario: Launch failure diagnostics remain safe

- **WHEN** the CLI emits credential, endpoint, or provider details while rejecting the model
- **THEN** public task failure and audit facts contain only the stable code and allowlisted safe context

### Requirement: Explicit model material fails closed before launch

The runtime SHALL resolve and materialize an explicit persisted model as a
required launch input. A database lookup error, missing/unreadable selector
file, checksum/materialization failure, or missing launch-context propagation
SHALL fail the Task with stable `runtime_model_setup_failed`; it SHALL NOT be
coerced to runtime-default intent. Only a successfully resolved persisted null
may select the byte-identical default launch branch.

#### Scenario: Persisted model lookup fails

- **WHEN** provisioning cannot determine whether the Task has null or explicit model intent because its lookup fails
- **THEN** the Task fails with `runtime_model_setup_failed` before runtime launch
- **AND** no default-model command is started

#### Scenario: Explicit model file is missing or unreadable

- **WHEN** a fresh launch has explicit model intent but its task-local selector material is missing, empty, unreadable, or invalid
- **THEN** the Task fails with `runtime_model_setup_failed` and no CLI fresh session starts

#### Scenario: Re-adopted fresh launch retains explicit intent

- **WHEN** admission recovery re-adopts a Task that has not started a session and has an explicit persisted model
- **THEN** it rematerializes and launches that exact selector or fails closed; it never falls back to the runtime default
