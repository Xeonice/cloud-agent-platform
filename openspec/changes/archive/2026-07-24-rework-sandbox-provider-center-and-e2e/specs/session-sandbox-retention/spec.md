## ADDED Requirements

### Requirement: Retention uses selected provider descriptors

Sandbox retention SHALL route through the selected provider and its retention descriptor. Retention, pre-stop trim, credential clearing, transcript capture, cleanup eligibility, and artifact removal SHALL not assume AIO container names or AIO HTTP exec URLs in API code. Provider-specific assumptions, when needed, SHALL live behind the owning provider package or sandbox harness.

#### Scenario: Retention uses selected command executor
- **WHEN** a provider-backed task reaches terminal teardown
- **THEN** pre-stop trim and credential-clearing commands run through the selected provider's command executor when reachable
- **AND** API code does not resolve `aio-http-exec-v1`, `boxlite-exec-v1`, or provider-specific command protocol strings directly

#### Scenario: Cleaner asks providers for cleanup candidates
- **WHEN** the retention cleaner sweeps provider-owned artifacts
- **THEN** it obtains cleanup candidates through provider-center retention descriptors or adapters
- **AND** it only removes artifacts the owning provider marks safe to remove

### Requirement: Provider e2e validates retention behavior

Real provider e2e SHALL validate each provider's retention and cleanup contract at the provider package layer.

#### Scenario: AIO e2e validates stopped retained artifact
- **WHEN** AIO provider e2e tears down a completed task according to its retention policy
- **THEN** it verifies the expected stopped or cleanup-eligible AIO artifact state
- **AND** it verifies explicit cleanup removes the e2e artifact

#### Scenario: BoxLite e2e validates provider retention descriptor
- **WHEN** BoxLite provider e2e provisions and tears down a sandbox
- **THEN** it verifies the provider retention descriptor and cleanup behavior match the advertised capabilities
- **AND** a running BoxLite sandbox is not deleted by cleanup logic
