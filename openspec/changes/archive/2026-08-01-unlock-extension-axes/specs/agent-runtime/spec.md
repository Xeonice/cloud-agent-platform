## ADDED Requirements

### Requirement: A compile-time-total runtime metadata table backs display and policy lookups

The contracts package SHALL declare a `RUNTIME_METADATA` table alongside the
runtime identifier declaration in `agent-runtime-id.ts`, written
`as const satisfies Record<AgentRuntimeId, ...>` so it is compile-time total:
adding a runtime identifier without adding its metadata row MUST fail typecheck.
The field set SHALL cover the consumers it replaces — at minimum a display label,
the CLI-preview copy consumed by the create-task dialog (absorbing the web-local
`RUNTIME_COPY` table), and the credential-alert description and action label —
and its credential-mode vocabulary SHALL be one unified or discriminated
declaration rather than two unrelated per-runtime mode types. Totality SHALL be
proven by a self-invalidating compile-fail fixture in the shape of the existing
`agent-runtime-registration.typecheck.ts` (`@ts-expect-error` probes for
Omit / Partial / empty-record / free-string weakenings).

#### Scenario: Adding a runtime without metadata fails to compile

- **WHEN** an identifier is added to `AGENT_RUNTIME_IDS` and no `RUNTIME_METADATA`
  row is supplied
- **THEN** the ordinary typecheck fails naming the missing key

#### Scenario: The totality guard self-invalidates

- **WHEN** the table's declared type is weakened to a Partial or index-signature
  shape
- **THEN** the ordinary typecheck fails via the fixture's `@ts-expect-error`
  probes rather than the fixture silently passing

#### Scenario: Metadata carries what the credential alert needs

- **WHEN** the credential alert copy for any declared runtime is resolved
- **THEN** the description and action label come from that runtime's
  `RUNTIME_METADATA` row, so no consumer needs a hardcoded per-runtime branch to
  render them

### Requirement: Runtime-identity ternaries at consumers are replaced by table lookups or schema parses

The api's runtime label sites SHALL read `RUNTIME_METADATA` instead of
branching on runtime identity (the two label ternaries in `task-failure.ts`). The
persisted-runtime parse site in `taskFailureFromRecord` is a parse/default
position, not a label position: it SHALL use `RuntimeSchema.safeParse` with
fallback to `DEFAULT_AGENT_RUNTIME_ID`, not a metadata lookup. The
adapter-boundary handwritten runtime union
(`runtime-model-adapter-snapshot.ts`) SHALL use the contracts runtime identifier
type. New consumers SHALL NOT introduce new runtime-identity ternaries (guarded
by the existing complement scan).

#### Scenario: Task-failure labels come from the table

- **WHEN** a task failure is rendered for any declared runtime
- **THEN** its runtime label resolves through `RUNTIME_METADATA`, and
  `task-failure.ts` contains no `runtime === 'claude-code' ? ... : ...` label
  ternary

#### Scenario: The persisted-runtime parse site keeps parse semantics

- **WHEN** `taskFailureFromRecord` reads a persisted runtime value
- **THEN** it parses via `RuntimeSchema.safeParse` and falls back to
  `DEFAULT_AGENT_RUNTIME_ID` on failure — accepting every declared runtime and
  falling back for unknown values, instead of collapsing all non-claude values
  through a two-way ternary

#### Scenario: The adapter boundary uses the declared type

- **WHEN** the signature of `assertRuntimeModelAdapterSnapshot` is inspected
- **THEN** its runtime parameter is the contracts runtime identifier type, not an
  inline handwritten `'codex' | 'claude-code'` union

### Requirement: The transcript read strategy is a shape-named vocabulary with real dispatch

`TranscriptReadStrategy` SHALL be a vocabulary of source-read shapes named by
shape, not by runtime: `single-newest-jsonl` and `per-message-json-dir`. The read
seam in the sandbox facade (the inline single-member check in
`configured-provider.ts`) SHALL become a real dispatch over the declared
strategy: every vocabulary member has an implementation, and a strategy value
outside the vocabulary remains a loud typed failure. This explicitly supersedes
the prior single-member loud-throw ruling because its triggering condition
changed: a per-message JSON directory store is a demonstrated second shape. The
second member MAY exist at compile time with no registered runtime declaring it.

#### Scenario: The codex and claude path is unchanged through the dispatch

- **WHEN** a `codex` or `claude-code` transcript is read after the dispatch lands
- **THEN** the `single-newest-jsonl` branch produces a `TranscriptSource` whose
  content is byte-identical to the pre-change read

#### Scenario: The second strategy member dispatches without a registered runtime

- **WHEN** a test harness supplies a runtime declaring the
  `per-message-json-dir` strategy
- **THEN** the read seam dispatches to that strategy's implementation instead of
  throwing the former single-member refusal

#### Scenario: An unknown strategy still fails loud

- **WHEN** the read seam receives a strategy value outside the declared
  vocabulary
- **THEN** it fails loudly with an error naming the strategy, rather than
  silently resolving to an absent source

## MODIFIED Requirements

### Requirement: Admitting a third runtime SHALL cost only a declaration and a registration

The cost of admitting an additional agent runtime SHALL be one entry in the
declaration, one registered implementation, and one data row in each
compile-time-total per-runtime policy table (`RUNTIME_METADATA` and the
runtime-conformance participation ledger). No further edit SHALL be required
to the validation schema, the identifier type, the readiness response shape, or
the persistence layer in order for that runtime to be accepted, resolved, and
reported — and no display or dispatch branch (identity ternary, `if`-chain, or
switch over runtime identifiers) SHALL need to be written in any consumer for
the new runtime to be labeled, previewed, credential-prompted, or
transcript-read.

Behaviour for the runtimes that exist today SHALL be unchanged: the same
identifiers SHALL be accepted, the same values rejected, and every wire shape
SHALL be identical to its shape before this requirement was introduced.

#### Scenario: The admission cost is measured rather than assumed

- **WHEN** an additional runtime identifier is introduced and the compiler is
  asked what else must change
- **THEN** the demanded edits SHALL be limited to supplying its implementation
  and its rows in the total policy tables, and any further demanded edit SHALL be
  treated as a defect in this boundary rather than accepted as necessary

#### Scenario: Existing runtime behaviour is unchanged

- **WHEN** the existing suites run against the derived vocabulary
- **THEN** every test SHALL pass without being rewritten, and the accepted and
  rejected identifier sets SHALL be identical to before

#### Scenario: A hypothetical third runtime needs no display or dispatch branch

- **WHEN** the typecheck drill adds a hypothetical third runtime identifier with
  its registration and table rows
- **THEN** typecheck passes with zero edits to label, CLI-preview,
  credential-alert, credentials-settings, or transcript-read consumer code, and
  the drill records that outcome as evidence
