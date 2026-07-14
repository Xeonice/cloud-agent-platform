## ADDED Requirements

### Requirement: Task creation uses the effective runtime model catalog

The console's one-off and recurring task-creation surfaces SHALL offer a model
selector driven by the shared runtime-model catalog for the currently selected
runtime and sandbox-environment state. The default choice SHALL submit no
`model` and be labeled as using the effective runtime default. The selector
SHALL represent loading, empty, constrained, unavailable, and ready catalog
states without falling back to a frontend-maintained static model list or an
unvalidated arbitrary text value.

#### Scenario: Runtime and environment drive the choices

- **WHEN** an operator changes the selected runtime or sandbox environment
- **THEN** the console queries the catalog for that exact three-state execution context
- **AND** the selector displays only the returned choices and their safe metadata

#### Scenario: Default model leaves the request field absent

- **WHEN** the operator keeps the "runtime default" choice
- **THEN** the one-off task or recurring template is submitted without a `model` selector

#### Scenario: A constrained catalog is not presented as complete

- **WHEN** the catalog response says its model set is constrained or best-known
- **THEN** the console communicates that limitation while allowing only the validated returned selectors

#### Scenario: Catalog failure is actionable

- **WHEN** model catalog loading fails
- **THEN** the console shows a retryable, non-secret error and a retry action
- **AND** it does not silently substitute a static list or submit a stale explicit selection

### Requirement: Context changes cannot silently submit a stale model

The console SHALL associate a selected model with the catalog context that
produced it. After runtime, environment, credential readiness, or returned
catalog revision changes, it SHALL retain the selector only if it is present in
the refreshed catalog; otherwise it SHALL clear the explicit selection to the
runtime default and inform the operator. A server-side unavailable/catalog
error at submit time SHALL refresh the catalog and preserve all unrelated form
input for correction.

#### Scenario: Selected model remains valid after refresh

- **WHEN** catalog context refreshes and the selected id remains available
- **THEN** the console retains the operator's selection

#### Scenario: Selected model disappears after context change

- **WHEN** the runtime or environment changes and the previously selected id is absent from the new catalog
- **THEN** the console clears that explicit selection, informs the operator, and does not submit it silently

#### Scenario: Server rejects a stale selection

- **WHEN** task or schedule submission returns `runtime_model_not_available` or `runtime_model_catalog_unavailable`
- **THEN** the form preserves prompt, repository, schedule, and guardrail inputs, refreshes the model state, and presents the safe server error

### Requirement: Task views distinguish requested and actual models

Task details and history surfaces SHALL display the requested model (or runtime
default when null) separately from a runtime-reported actual model when that
fact is available. If the values differ, the console SHALL show both without
claiming that the task request was rewritten.

#### Scenario: Requested alias resolves to an actual model

- **WHEN** a task requested an alias and session history reports a concrete actual model
- **THEN** the console labels and displays both the requested selector and actual model

#### Scenario: Actual model is unknown

- **WHEN** the runtime has not reported an actual model
- **THEN** the console displays the requested choice or runtime-default intent and does not invent an actual value

### Requirement: Schedule views expose model preflight and retry state

The console SHALL distinguish a permanent unavailable-model occurrence from a
transient catalog outage that is retrying. It SHALL display the stable error
code and safe message, and for retrying occurrences SHALL display attempt and
next-retry information without claiming that a Task has started.

#### Scenario: Catalog outage is waiting to retry

- **WHEN** a schedule run has status `retrying` with `runtime_model_catalog_unavailable`
- **THEN** the schedule UI shows the next retry and attempt state with no Task link

#### Scenario: Model failure is terminal

- **WHEN** a schedule run has terminal `runtime_model_not_available`
- **THEN** the schedule UI explains that the selector must be changed and does not present the occurrence as still retrying
