# account-settings — delta for fix-claude-onboarding-and-token-verify

## MODIFIED Requirements

### Requirement: Claude Code runtime credential
The system SHALL support an Agent-runtime credential for Claude Code, distinct from the
Codex credential, with two modes: a Claude subscription token produced by
`claude setup-token` (a long-lived token the operator pastes) and an Anthropic API Key.
The credential SHALL be stored encrypted at rest and never returned in plaintext
(suffix only), mirroring the Codex credential handling, and SHALL be selectable as the
runtime when creating a task per the runtime selector.

Saving a Claude credential SHALL verify it against Anthropic before it can reach the
`connected` state: the save path performs a single live probe using the
mode-appropriate authentication scheme (OAuth bearer with the oauth beta header for
subscription mode; `x-api-key` for API-key mode) against the fixed Anthropic API host.
A definitive authentication rejection (401/403-class `authentication_error`) SHALL
refuse the save with a descriptive error, persist nothing, and leave any prior
credential state untouched. A definitive acceptance (the request passes authentication,
regardless of subsequent request-body validation outcome) SHALL persist the credential
as `connected`. A network-indeterminate probe outcome (timeout, connection/DNS failure,
Anthropic 5xx) SHALL NOT block the save — the credential persists as `connected` and
the save response carries an explicit indeterminate-verification marker the console
surfaces as a warning — so restricted-egress self-hosted deployments can still save
credentials. The probe SHALL run once per save (no retries), never log or echo the
secret, and never persist the probe payload.

#### Scenario: Claude subscription token is saved and masked
- **WHEN** the operator pastes a `claude setup-token` token that passes verification and saves
- **THEN** the token is stored encrypted and only its suffix is shown afterward, and
  Claude Code becomes an available runtime for task creation

#### Scenario: Anthropic API Key alternative
- **WHEN** the operator saves an Anthropic API Key (instead of a subscription token)
  that passes verification
- **THEN** it is stored encrypted and masked (suffix only) and is used to run Claude
  Code by usage-based billing

#### Scenario: Claude credential is distinct from Codex credential
- **WHEN** both a Codex credential and a Claude Code credential are configured
- **THEN** each is stored and surfaced independently, and selecting a task's runtime
  chooses which credential is used

#### Scenario: Invalid token is rejected at save time
- **WHEN** the operator pastes a token that Anthropic rejects with an
  authentication error (401/403-class)
- **THEN** the save is refused with a descriptive error naming the rejection, nothing
  is persisted, the credential does not become `connected`, and any previously stored
  credential remains in its prior state

#### Scenario: Verification passes without consuming usage
- **WHEN** a valid credential is saved and the probe's request passes authentication
  but fails request-body validation (an HTTP 400 with no tokens consumed)
- **THEN** the credential is treated as verified and persists as `connected`

#### Scenario: Restricted egress does not block saving
- **WHEN** the operator saves a credential and the probe cannot reach Anthropic
  (timeout, DNS/connection failure, or a 5xx)
- **THEN** the credential is persisted as `connected` and the response carries an
  indeterminate-verification marker that the console surfaces as a warning

#### Scenario: Probe never leaks the secret
- **WHEN** a save-time verification runs (any outcome)
- **THEN** no log line, error message, or API response contains the token/key plaintext
  or any fragment beyond the existing masked suffix
