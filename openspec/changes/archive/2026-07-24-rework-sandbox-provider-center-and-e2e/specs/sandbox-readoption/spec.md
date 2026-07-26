## ADDED Requirements

### Requirement: Provider center owns readoption routing

Readoption SHALL be coordinated by the provider center. It SHALL prefer durable provider owner metadata when present, and only use provider probing for older tasks without owner records or migration compatibility.

#### Scenario: Stored provider owner selects readoption provider
- **WHEN** a running task has durable owner metadata for a provider
- **THEN** the provider center asks that provider to reattach the task first
- **AND** it does not probe unrelated providers before the stored owner

#### Scenario: Probing fallback requires ownership proof
- **WHEN** a task lacks durable provider owner metadata
- **THEN** the provider center may probe compatible providers
- **AND** it only readopts through a provider that proves the provider sandbox and detached session are alive for that task

### Requirement: Provider e2e validates readoption without API restart

Provider-package e2e SHALL validate readoption by recreating provider and provider-center instances in-process rather than by restarting the CAP API backend.

#### Scenario: Provider instance restart readopts task sandbox
- **WHEN** provider e2e provisions a real sandbox and discards the provider instance
- **THEN** a new provider instance can reattach or prove ownership according to that provider's readoption contract
- **AND** selected-run operations continue through the readopted provider owner
