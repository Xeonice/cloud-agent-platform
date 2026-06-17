## MODIFIED Requirements

### Requirement: Compatible-provider model discovery and selection
The system SHALL support discovering available models for a configured compatible provider ("获取可用模型") using the provider's base URL and API key, returning a list of selectable model identifiers, and SHALL allow the account to select one as the default model persisted with the credential. Model discovery SHALL be available without first persisting the credential (so a candidate base URL + key can be validated), and SHALL surface a clear error when discovery fails (e.g. unreachable base URL or rejected key) without persisting an invalid credential. The discovery request/response contract SHALL live in the shared `@cap/contracts` package (not only in the API app) so the web client can call the endpoint type-safely. Before issuing the server-side probe, the system SHALL validate the operator-supplied base URL for safety and SHALL REJECT it without fetching when its scheme is not `http`/`https` or its host resolves to a loopback, private, link-local, unique-local, unspecified (`0.0.0.0`/`::`), or cloud-metadata (`169.254.169.254`) address — so the discovery endpoint cannot be used as a server-side request forgery (SSRF) vector against internal services. The probe SHALL enforce a bounded request timeout (so a slow/unresponsive provider cannot hang the request), SHALL constrain redirects (re-validating any redirect target against the same host rules), and SHALL bound the response body size before parsing. The API key SHALL be used only as the provider Authorization bearer and SHALL NOT be logged or returned.

#### Scenario: Discover models for a compatible provider
- **WHEN** an account requests available models with a valid base URL and API key
- **THEN** the system returns the provider's list of model identifiers for selection

#### Scenario: Selected default model persists with the credential
- **WHEN** an account selects a model from the discovered list and saves the credential
- **THEN** the selected default model is persisted and returned (in plaintext, as it is not secret) by the settings read API

#### Scenario: Failed discovery does not persist a broken credential
- **WHEN** model discovery fails because the base URL is unreachable or the API key is rejected
- **THEN** the system returns a discovery error and does not mark the credential as `connected`

#### Scenario: Discovery rejects unsafe (SSRF) base URLs without fetching
- **WHEN** an account requests discovery with a base URL whose scheme is not http/https or whose host is loopback/private/link-local/metadata (e.g. `http://169.254.169.254/`, `http://localhost:6379`, `file:///etc/passwd`)
- **THEN** the system rejects the request before issuing any outbound fetch and performs no network call to that host

#### Scenario: Discovery is time- and size-bounded
- **WHEN** a configured provider is slow to respond or returns an oversized body
- **THEN** the probe aborts on a bounded timeout (reported as an unreachable/timeout failure) and does not buffer an unbounded response body

### Requirement: Codex credential storage with two provider modes
The system SHALL store, per account, a Codex execution credential supporting two mutually exclusive modes: (a) an official-account connection whose persisted state is a connection status (e.g. `connected` / `not_connected`) and optional non-secret metadata, and (b) a compatible-provider connection consisting of a base URL plus an API key and an optional selected default model. A save in compatible mode SHALL REQUIRE a non-null base URL (enforced server-side, not only by the UI), so a key-only or otherwise incoherent half-row cannot be persisted. The read API SHALL return the active mode and a connection state of `not_connected`, `not_saved`, or `connected` so the settings status card, the active tab subtitle, and the provider pill can render the same state consistently. A compatible credential SHALL be reported as `connected` ONLY when it has been validated against the provider (a successful discovery/test), NOT on the mere presence of a base URL and stored key; field presence without a successful validation SHALL read as `not_saved`.

#### Scenario: Official-account mode stores connection state only
- **WHEN** an account connects the official Codex account
- **THEN** the stored credential records the official mode with a `connected` state and stores no compatible-provider base URL or API key

#### Scenario: Compatible-provider mode stores base URL, key, and default model
- **WHEN** an account saves a compatible provider with a base URL, an API key, and a selected default model that has been successfully validated against the provider
- **THEN** the stored credential records the compatible mode with that base URL and default model and a `connected` state

#### Scenario: Compatible save without a base URL is rejected
- **WHEN** a save request specifies compatible mode but carries no base URL
- **THEN** the system rejects the save (no incoherent compatible row is persisted)

#### Scenario: Compatible credential present but unvalidated reads as not_saved
- **WHEN** a compatible base URL and key are stored but no successful validation has occurred
- **THEN** the read API reports the compatible mode with a `not_saved` state rather than `connected`

#### Scenario: Unsaved compatible provider reads back as not_saved
- **WHEN** an account has entered a base URL but has not yet successfully saved a key
- **THEN** the read API reports the compatible mode with a `not_saved` state so the status card, tab subtitle, and provider pill all show the same "未保存" condition
