## ADDED Requirements

### Requirement: Console renders owner and administrator provisioning diagnostics safely

The session-authenticated Console task detail SHALL provide a provisioning
diagnostics view backed by the same task-owned diagnostic query service and
canonical strict response schema as Public V1 and MCP. A non-administrator
account SHALL read only its own task; an administrator MAY inspect a cross-owner
or ownerless historical task. The Internal Console route SHALL accept only a
session principal, and before cross-owner access it SHALL re-read the live User
row and require `allowed = true` plus current `role = admin`; it SHALL NOT trust
a stale session role snapshot. The Console SHALL enforce this authorization on
the server before returning data and SHALL NOT rely on hiding a tab or route in
the browser as the access-control boundary.

The view SHALL group the bounded timeline by provisioning attempt and render
safe stage/operation, outcome, timing, retry, settlement-degradation, and
evidence-availability facts from the canonical union. It SHALL display the
primary provisioning failure separately from any secondary cleanup failure or
cleanup-confirmation state so cleanup cannot visually replace the original
cause. Pagination SHALL use the canonical `limit`/`cursor` contract and stable
ordering; loading another page SHALL append records without duplicating or
reordering the timeline.

For accepted tasks that have not started provider processing and for tasks that
predate diagnostic persistence or have only partial evidence, the view SHALL
render the canonical not-started/empty/degraded state rather than reconstructing
a cause from audit prose, terminal replay, or rotated logs. The view SHALL never display command text,
stdout/stderr, request or response bodies, headers, authenticated repository
URLs, credentials or temporary paths, prompts, environment dumps, lease
owners, provider endpoints, stacks, or arbitrary diagnostic fields. Ordinary
task status, transcript, terminal, and schedule projections SHALL continue to
consume the existing Task schemas and SHALL NOT be widened with the diagnostic
ledger.

API-key and MCP-token scope selectors in Settings SHALL offer
`tasks:diagnostics` as an explicit opt-in permission with a warning that it
grants deeper task provisioning evidence. Existing defaults and previously
minted credentials SHALL remain unchanged; selecting `tasks:read` or
`tasks:write` SHALL NOT automatically select it.

#### Scenario: Task owner sees a safe attempt timeline

- **WHEN** an authenticated non-administrator opens provisioning diagnostics for a task owned by that account
- **THEN** the Console renders the canonical attempt-grouped timeline in stable order
- **AND** primary provisioning and secondary cleanup outcomes are visually distinct

#### Scenario: Administrator inspects a cross-owner task

- **WHEN** an authenticated administrator opens diagnostics for another account's task
- **THEN** the server-authorized canonical query returns the safe timeline
- **AND** the UI does not bypass or duplicate the shared query service

#### Scenario: Administrator authorization is rechecked live

- **WHEN** a session snapshot says admin but the current User row is disabled or no longer has `role = admin`
- **THEN** the Internal Console route denies the cross-owner diagnostic read
- **AND** no Public V1, MCP, API-key, or legacy-token principal receives the Console administrator exception

#### Scenario: Non-owner access fails closed

- **WHEN** an authenticated non-administrator navigates directly to diagnostics for another account's task
- **THEN** the server rejects the read without returning timeline data
- **AND** hiding or showing the client view has no bearing on the authorization result

#### Scenario: Legacy task renders an honest degraded state

- **WHEN** an authorized operator opens a task created before complete provisioning diagnostics were retained
- **THEN** the view shows the canonical partial or unavailable evidence state
- **AND** it does not invent a command failure, provider cause, or cleanup result from generic history

#### Scenario: Accepted task renders not-started evidence

- **WHEN** durable work is committed or capacity-queued but no provider attempt has begun
- **THEN** the view shows its canonical admission state with not-started diagnostic coverage
- **AND** it does not label the empty attempt timeline as unavailable history or provider failure

#### Scenario: Pagination preserves timeline order

- **WHEN** an operator loads successive diagnostic pages
- **THEN** each record appears once in stable ledger order under its attempt
- **AND** no page load reorders earlier events or merges primary and cleanup outcomes

#### Scenario: Console never renders forbidden diagnostic material

- **WHEN** provider and cleanup failures contain a unique secret canary, commands, output, endpoints, or stack text
- **THEN** none of that material appears in the diagnostics view, browser query cache, error toast, or copied text

#### Scenario: Diagnostic credential scope is opt-in

- **WHEN** an operator configures scopes for a new API key or MCP token
- **THEN** `tasks:diagnostics` is available as a separate unchecked permission
- **AND** selecting ordinary task read or write permissions does not grant it
