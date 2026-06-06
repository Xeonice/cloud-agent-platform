# account-settings Specification

## Purpose
TBD - created by archiving change rebuild-console-tanstack-start. Update Purpose after archive.
## Requirements
### Requirement: Account preferences persistence and retrieval
The system SHALL persist per-account console preferences and expose a read API that returns the current preferences for the authenticated, allowlisted account. Preferences SHALL include at least: the allowlisted account display identity (read-only, sourced from the OAuth identity, e.g. `tanghehui`), a default repository selection (referencing an imported repo by id, nullable), a history/audit retention window (e.g. `30` days), and a destructive-action gate toggle ("破坏性写入前停止" / write-confirm). Preferences SHALL be scoped to the owning account and SHALL NOT leak across accounts. The allowlisted account display identity SHALL be read-only and SHALL NOT be writable through the settings update API, because "who can log into the console" is governed by the multi-user-oauth allowlist, not by editable preferences.

#### Scenario: Read returns the account's stored preferences
- **WHEN** an authenticated, allowlisted account GETs the settings read endpoint
- **THEN** the response includes the allowlisted account display identity, the selected default repository (or null), the retention window in days, and the write-confirm/destructive-action gate toggle
- **AND** the values reflect what that account last saved (defaults are returned when nothing has been saved yet)

#### Scenario: Preferences are scoped per account
- **WHEN** account A and account B each read their settings after saving different preferences
- **THEN** each account receives only its own stored preferences and never sees the other account's values

#### Scenario: Allowlisted account display identity is read-only
- **WHEN** a settings update request attempts to change the allowlisted account display identity
- **THEN** the request is rejected (or the field is ignored) and the displayed identity continues to derive solely from the account's OAuth identity

### Requirement: Settings update API
The system SHALL expose an update API that writes account preferences, validating the request body against the shared contracts schema before persisting, and SHALL return the updated, sanitized settings (the same shape as the read API, with no secret material) on success. A default repository selection SHALL be accepted only when it references a repository the account has imported; the retention window SHALL be constrained to an allowed set/range; an invalid body SHALL be rejected without mutating any stored preference.

#### Scenario: Valid update persists and reads back
- **WHEN** an account PATCHes/PUTs a valid settings body changing the default repository, retention window, and write-confirm toggle
- **THEN** the API responds 200 with the updated sanitized settings
- **AND** a subsequent read returns exactly those updated values

#### Scenario: Default repository must be an imported repo
- **WHEN** an update sets the default repository to a repo id the account has not imported
- **THEN** the API responds with a 4xx validation error and the previously stored default repository is unchanged

#### Scenario: Invalid body leaves stored preferences untouched
- **WHEN** an update body fails the contracts schema (e.g. retention window out of the allowed range)
- **THEN** the API responds with HTTP 400 and no stored preference is modified

### Requirement: Codex credential is a distinct concept from console login identity
The system SHALL model the Codex execution credential ("任务运行用什么模型") as a concept entirely distinct from the OAuth console login identity ("谁能进控制台"). Connecting, replacing, or clearing a Codex credential SHALL NOT alter the account's OAuth identity or allowlist membership, and signing in/out of the console SHALL NOT mutate stored Codex credentials. Settings UI and copy SHALL keep these two concepts separate and SHALL NOT present the Codex credential connection as a console login.

#### Scenario: Connecting a Codex credential does not change login identity
- **WHEN** an account connects or updates its Codex credential
- **THEN** the account's OAuth identity and allowlist membership are unchanged and the account remains logged in as the same identity

#### Scenario: Console logout does not clear Codex credential
- **WHEN** an account logs out of the console and later logs back in
- **THEN** its previously stored Codex credential connection state is preserved (the credential is not erased by the logout)

### Requirement: Codex credential storage with two provider modes
The system SHALL store, per account, a Codex execution credential supporting two mutually exclusive modes: (a) an official-account connection whose persisted state is a connection status (e.g. `connected` / `not_connected`) and optional non-secret metadata, and (b) a compatible-provider connection consisting of a base URL plus an API key and an optional selected default model. The read API SHALL return the active mode and a connection state of `not_connected`, `not_saved`, or `connected` so the settings status card, the active tab subtitle, and the provider pill can render the same state consistently.

#### Scenario: Official-account mode stores connection state only
- **WHEN** an account connects the official Codex account
- **THEN** the stored credential records the official mode with a `connected` state and stores no compatible-provider base URL or API key

#### Scenario: Compatible-provider mode stores base URL, key, and default model
- **WHEN** an account saves a compatible provider with a base URL, an API key, and a selected default model
- **THEN** the stored credential records the compatible mode with that base URL and default model and a `connected` state once a valid key is saved

#### Scenario: Unsaved compatible provider reads back as not_saved
- **WHEN** an account has entered a base URL but has not yet successfully saved a key
- **THEN** the read API reports the compatible mode with a `not_saved` state so the status card, tab subtitle, and provider pill all show the same "未保存" condition

### Requirement: Codex API key encrypted at rest and never returned in plaintext
The system SHALL encrypt the compatible-provider API key at rest using a server-held key (e.g. AES-GCM with a key from configuration) and SHALL NEVER return the plaintext API key from any read or update API. Reads SHALL expose only a non-reversible presence indicator (e.g. `hasApiKey: true`/`false` and/or a masked suffix), never the key itself. The plaintext key SHALL exist in memory only transiently to perform encryption on save and decryption at the point of task execution; it SHALL NOT be logged.

#### Scenario: Saved key is never echoed back
- **WHEN** an account saves a compatible-provider API key and then reads settings
- **THEN** the response contains a presence indicator (and optionally a masked suffix) but no plaintext API key field

#### Scenario: Key is encrypted in the datastore
- **WHEN** the persisted credential row is inspected directly in the database
- **THEN** the stored API key value is ciphertext (not the plaintext entered by the user)

#### Scenario: Update without re-sending the key preserves the stored key
- **WHEN** an account updates other credential fields (e.g. base URL or default model) without re-submitting the API key
- **THEN** the previously stored encrypted key is preserved rather than overwritten with an empty value

### Requirement: Compatible-provider model discovery and selection
The system SHALL support discovering available models for a configured compatible provider ("获取可用模型") using the provider's base URL and API key, returning a list of selectable model identifiers, and SHALL allow the account to select one as the default model persisted with the credential. Model discovery SHALL be available without first persisting the credential (so a candidate base URL + key can be validated), and SHALL surface a clear error when discovery fails (e.g. unreachable base URL or rejected key) without persisting an invalid credential.

#### Scenario: Discover models for a compatible provider
- **WHEN** an account requests available models with a valid base URL and API key
- **THEN** the system returns the provider's list of model identifiers for selection

#### Scenario: Selected default model persists with the credential
- **WHEN** an account selects a model from the discovered list and saves the credential
- **THEN** the selected default model is persisted and returned (in plaintext, as it is not secret) by the settings read API

#### Scenario: Failed discovery does not persist a broken credential
- **WHEN** model discovery fails because the base URL is unreachable or the API key is rejected
- **THEN** the system returns a discovery error and does not mark the credential as `connected`

### Requirement: Test/validate a saved Codex credential
The system SHALL provide a way to test a Codex credential's connectivity ("测试凭据") that reports success or a descriptive failure without exposing the API key, so an account can confirm a connection before relying on it for task execution. The test result SHALL NOT alter the persisted connection mode on failure.

#### Scenario: Successful credential test reports connected
- **WHEN** an account tests a stored compatible-provider credential whose base URL and key are valid
- **THEN** the system reports a successful test result without returning the plaintext API key

#### Scenario: Failed credential test reports an error and does not flip state to connected
- **WHEN** an account tests a credential whose key is invalid or whose base URL is unreachable
- **THEN** the system reports a descriptive failure and the credential is not marked `connected`

