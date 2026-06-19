## ADDED Requirements

### Requirement: Claude Code runtime credential
The system SHALL support an Agent-runtime credential for Claude Code, distinct from the Codex credential, with two modes: a Claude subscription token produced by `claude setup-token` (a long-lived token the operator pastes) and an Anthropic API Key. The credential SHALL be stored encrypted at rest and never returned in plaintext (suffix only), mirroring the Codex credential handling, and SHALL be selectable as the runtime when creating a task per the runtime selector.

#### Scenario: Claude subscription token is saved and masked
- **WHEN** the operator pastes a `claude setup-token` token and saves
- **THEN** the token is stored encrypted and only its suffix is shown afterward, and Claude Code becomes an available runtime for task creation

#### Scenario: Anthropic API Key alternative
- **WHEN** the operator saves an Anthropic API Key instead of a subscription token
- **THEN** it is stored encrypted and masked (suffix only) and is used to run Claude Code by usage-based billing

#### Scenario: Claude credential is distinct from Codex credential
- **WHEN** both a Codex credential and a Claude Code credential are configured
- **THEN** each is stored and surfaced independently, and selecting a task's runtime chooses which credential is used
