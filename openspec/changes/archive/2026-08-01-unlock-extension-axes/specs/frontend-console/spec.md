## ADDED Requirements

### Requirement: Runtime display surfaces are driven by contracts metadata with no console branches

Console surfaces that render per-runtime copy SHALL read the contracts metadata:
the runtime credential alert (description and action label) and runtime labels
SHALL resolve the
`RUNTIME_METADATA` row for the task's runtime instead of branching on runtime
identity. No console component SHALL contain a runtime-identity branch (ternary,
`if`-chain, or switch) for display copy. A runtime added to the contracts
declaration with a complete metadata row SHALL appear across these surfaces with
no console code edit.

#### Scenario: Credential alert copy comes from the metadata row

- **WHEN** a task fails with a runtime credential failure for any declared
  runtime
- **THEN** the alert renders that runtime's metadata description and action
  label, and the alert component contains no `runtime === 'claude-code'` branch

#### Scenario: A new runtime surfaces without console edits

- **WHEN** a runtime is declared in contracts with a complete metadata row
- **THEN** the credential alert and the credentials settings surfaces render it
  from the declared collection with zero edits to console components

### Requirement: The skill catalog id vocabulary is declared once in contracts

The skill id vocabulary SHALL be declared once in the contracts package. The web
skill catalog SHALL derive its option ids from that declaration while keeping
display copy (labels, hints) web-side, and the api skill allowlist SHALL key its
installer commands by the same declaration while keeping installer commands
api-side. Both ends SHALL genuinely import the contracts declaration — the lift
is not complete while either side keeps a local id list.

#### Scenario: Web options and api allowlist share one id set

- **WHEN** the web catalog's option ids and the api allowlist's keys are compared
- **THEN** both derive from the same contracts declaration, so a skill id cannot
  exist on one side without the other

#### Scenario: Both sides import the declaration

- **WHEN** the contracts-shared usage check runs after the lift
- **THEN** the skill id declaration has real importers in both `apps/web` and
  `apps/api` (no lifted-but-unused state), and the previous local id lists are
  gone

## MODIFIED Requirements

### Requirement: Create-task dialog offers a runtime selector gated on readiness

The create-task dialog SHALL present a runtime selector whose options enumerate
the contracts-declared runtime collection, with labels, hints, and
command-preview copy read from each runtime's `RUNTIME_METADATA` row (absorbing
the dialog-local `RUNTIME_COPY` table) rather than from per-runtime dialog code;
the selected value is sent in the create-task request body as `runtime`,
defaulting to the declared default runtime (`Codex` today). The selector SHALL be
gated on a runtime-readiness read (see `agent-runtime`): a runtime that is not
configured/ready SHALL be shown disabled with an affordance pointing the operator
to configure it, rather than being selectable and failing at launch. The command
preview SHALL reflect the selected runtime using its metadata CLI-preview copy
(showing the `claude`-based invocation when Claude Code is chosen, the
`codex`-based invocation for Codex), with no runtime-identity ternary in the
dialog source.

#### Scenario: Operator selects an available runtime

- **WHEN** both runtimes report ready and the operator selects `Claude Code`
- **THEN** the create request body carries `runtime = claude-code` and the
  command preview reflects the Claude invocation

#### Scenario: Unconfigured runtime is disabled

- **WHEN** the Claude runtime reports not ready
- **THEN** the `Claude Code` option is shown disabled with a configure hint, and
  `Codex` remains the default selectable runtime

#### Scenario: Selector options and preview copy come from the declared collection

- **WHEN** the dialog renders its runtime options and command preview
- **THEN** both are produced by mapping the contracts-declared runtime collection
  and its metadata rows, and the dialog source contains no local per-runtime copy
  table and no runtime-identity ternary for preview text

#### Scenario: A newly declared runtime appears without dialog edits

- **WHEN** a runtime is added to the contracts declaration with its metadata row
  and readiness reporting
- **THEN** the dialog lists it (enabled or disabled per readiness) with label,
  hint, and preview from its metadata row, with no edit to the dialog component

### Requirement: Settings model credentials organized by Agent runtime

The settings model-credential section SHALL be organized by Agent runtime,
rendering one group per contracts-declared runtime from collection data (a
collection keyed by runtime identifier carrying each runtime's credential state
and configure handler) rather than hard-wired per-runtime props and handlers, and
SHALL expose both runtimes the platform supports today: a Codex group (官方 Codex
账号 / 兼容模型提供方) and a Claude Code group (Claude 订阅 setup-token /
Anthropic API Key). Each runtime SHALL show its own connection status, and the
Claude Code group SHALL provide an entry to configure a `claude setup-token`
subscription token and an Anthropic API Key. Credential-mode handling SHALL use
the unified or discriminated credential-mode vocabulary from the runtime
metadata rather than two unrelated per-runtime mode types. Saved secrets SHALL
be masked (suffix only) and never re-displayed in plaintext.

#### Scenario: Claude Code credential entry is present

- **WHEN** the operator opens the Agent model-credential section
- **THEN** a Claude Code runtime group is shown with a setup-token entry and an
  Anthropic API Key entry, alongside the Codex group

#### Scenario: Saved Claude credential is masked

- **WHEN** a Claude setup-token or Anthropic API Key has been saved
- **THEN** it is not shown again in plaintext

#### Scenario: Credential groups are collection-driven

- **WHEN** the credential section component's interface is inspected
- **THEN** it accepts a collection keyed by runtime identifier (credential state
  plus configure handler per declared runtime) instead of per-runtime prop
  pairs, and renders its groups by mapping the declared collection
