## ADDED Requirements

### Requirement: cloud-http conformance runs against a real HTTP reference server

The sandbox-cloud-http conformance suite SHALL run its protocol scenarios
against a real bound HTTP listener served by an explicitly named reference
server, not against a hand-written in-process fetch stub. The reference server
SHALL be a first-class deliverable that acts as executable documentation of the
protocol, implementing all 7 required endpoints enumerated in the package README
(`POST /v1/sandboxes`, `GET /v1/sandboxes/:taskId`,
`DELETE /v1/sandboxes/:taskId`, `GET /v1/sandboxes/:taskId/transcript`,
`POST /v1/sandboxes/:taskId/deliver`, `GET /v1/sandboxes/readoptable`,
`POST /v1/sandboxes/:taskId/reattach`). Fetch stubs MAY remain only in the
reference server's own downstream tests. The package (provider, conformance, and
reference server) SHALL be inside the workspace build graph so these suites
compile and run in CI.

#### Scenario: Conformance exercises the reference server over real HTTP

- **WHEN** the cloud-http conformance suite runs
- **THEN** the provider under test issues real HTTP requests to a bound listener
  backed by the reference server, and all 7 README endpoints are exercised
  through that listener

#### Scenario: Protocol drift is caught by conformance rather than review

- **WHEN** the reference server's handling of a required endpoint diverges from
  the provider's protocol expectation
- **THEN** the conformance suite fails — the prior failure mode, where a
  hand-written stub silently mirrored the provider's own assumptions while the
  README drifted, is no longer possible for these scenarios

#### Scenario: The package is in the workspace build graph

- **WHEN** the workspace-wide build and typecheck run
- **THEN** `packages/sandbox-cloud-http`, including the reference server and its
  conformance suite, is compiled and its tests are executed, so a breaking edit
  fails CI instead of landing in a dead package

### Requirement: Optional protocol self-description degrades gracefully

Capability and version self-description endpoints for a cloud-http server SHALL
be a purely additive, optional extension. A server that does not implement them
SHALL be treated as a baseline server — graceful degradation, never an error.
Version negotiation SHALL counter-offer: when the server advertises a different
supported specification version, the outcome is either a mutually supported
negotiated version or a typed, actionable mismatch result — not a blanket
rejection of the server.

#### Scenario: A baseline server without self-description works unchanged

- **WHEN** the provider connects to a server implementing only the 7 required
  endpoints
- **THEN** every baseline conformance scenario passes and no self-description
  error is raised — absence of the optional endpoints is not a failure

#### Scenario: Version negotiation counter-offers instead of rejecting

- **WHEN** the server advertises a specification version other than the
  provider's preferred version
- **THEN** negotiation resolves to a mutually supported version when one exists,
  and otherwise produces a typed mismatch outcome naming both versions rather
  than treating the server as broken

### Requirement: Provider-local secret-writer rejections are preserved

The two provider-local secret-writer hard rejections in the cloud-http provider SHALL be preserved unchanged by the reference-server work: writing secret
material remains a provider-local trust-boundary refusal, and no reference-server
or self-description pathway SHALL ship secret material to the remote server. The
conformance suite SHALL assert both rejections against the real reference server.

#### Scenario: Secret-writer refusals survive the real-server migration

- **WHEN** the conformance suite drives the code paths guarded by the two
  secret-writer rejections, now running against the reference server
- **THEN** both rejections fire exactly as they did against the stub, and no
  request carrying secret material reaches the reference server's listener
