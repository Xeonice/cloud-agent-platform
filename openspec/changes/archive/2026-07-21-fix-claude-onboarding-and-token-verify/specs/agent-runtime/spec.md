# agent-runtime — delta for fix-claude-onboarding-and-token-verify

## MODIFIED Requirements

### Requirement: Provision-time trust and onboarding pre-seed
At provision time the runtime SHALL pre-seed the Claude global config with the GLOBAL
onboarding keys (`theme`, `hasCompletedOnboarding`) AND the per-project trust entry
(`projects[<canonicalized-workspace>].hasTrustDialogAccepted = true`,
`hasCompletedProjectOnboarding = true`) — because the per-project trust entry alone does
NOT suppress the first-run global theme/onboarding screen — and it SHALL write the
IDENTICAL pre-seed content to BOTH candidate config locations:
**`$CLAUDE_CONFIG_DIR/.claude.json`** (e.g. `/home/gem/.claude/.claude.json` — the
location claude ≥ 2.1.207 reads when `CLAUDE_CONFIG_DIR` is set, matching current
official documentation) AND **`$HOME/.claude.json`** (the sandbox HOME root — the
location observed authoritative on 2.1.181-era versions, which ignored the config-dir
copy). Seeding both paths is required because sandbox images pin different claude
versions across deployments and the upstream behavior has flipped between these two
locations; whichever copy the pinned version ignores is inert. The pre-seed SHALL NOT
target only one of the two paths. This is the Claude analog of codex's `config.toml`
trust step.

#### Scenario: First interactive launch is not blocked by onboarding
- **WHEN** Claude starts for the first time in the sandbox HOME with the pre-seed present
- **THEN** no theme-selection or onboarding screen appears and the prompt auto-runs

#### Scenario: Pre-seed reaches both candidate config locations
- **WHEN** the runtime emits the provision-time pre-seed for a `claude-code` task
- **THEN** the `.claude.json` carrying `theme` + `hasCompletedOnboarding` and the
  per-project trust entry is written to BOTH `$CLAUDE_CONFIG_DIR/.claude.json` AND the
  sandbox HOME root `$HOME/.claude.json`, with identical content and owner-only file
  modes

#### Scenario: Config-dir-reading claude version skips onboarding
- **WHEN** a claude version that reads its main config at `$CLAUDE_CONFIG_DIR/.claude.json`
  (≥ 2.1.207 behavior) starts with the dual-path pre-seed present
- **THEN** it observes `hasCompletedOnboarding:true` from the config-dir copy and no
  onboarding wizard (theme or login-method screen) appears

#### Scenario: HOME-root-reading claude version skips onboarding
- **WHEN** a claude version that reads its main config at `$HOME/.claude.json`
  (2.1.181-era behavior) starts with the dual-path pre-seed present
- **THEN** it observes `hasCompletedOnboarding:true` from the HOME-root copy and no
  onboarding wizard appears

#### Scenario: Skipping onboarding lets the injected token authenticate without a prompt
- **WHEN** the dual-path pre-seed marks `hasCompletedOnboarding:true` and
  `CLAUDE_CODE_OAUTH_TOKEN` is injected
- **THEN** Claude skips the entire onboarding flow (theme AND auth) and authenticates
  with the injected token, with no `/login` or token prompt

## ADDED Requirements

### Requirement: Claude auth-failure classification covers current CLI phrasings
`classifyClaudeOutputFailure` SHALL classify, in addition to its existing patterns,
(a) the inline TUI auth-error line emitted by current claude versions — a single
terminal line carrying both a `/login` instruction and an `API Error: 401`-class
rejection (e.g. `● Please run /login · API Error: 401 Invalid bearer token`) — as
`runtime_auth_rejected` (or `runtime_auth_expired` when the same line shape carries an
expired-token message), and (b) the first-run onboarding wizard screen — identified by
the co-occurrence of the stable anchors `Welcome to Claude Code` AND
`Select login method` in the rolling output window — as `runtime_auth_rejected`,
because a visible wizard means onboarding suppression failed and the task can never
proceed without interactive input. Both classifications SHALL be narrow: the inline
line matches only as a standalone terminal line (visual bullet prefixes stripped), and
the wizard match requires BOTH anchors, so prose or transcripts quoting a single
fragment do not classify. A `claude-code` task whose rolling output matches either
pattern SHALL terminate as a classified auth failure with the existing
`reconnect_runtime` operator action rather than remaining `running` indefinitely.

#### Scenario: Inline 401 line fails the task as auth-rejected
- **WHEN** a `claude-code` task's rolling output contains the standalone line
  `● Please run /login · API Error: 401 Invalid bearer token`
- **THEN** the output is classified `runtime_auth_rejected` and the task fails with the
  `reconnect_runtime` action instead of staying `running`

#### Scenario: Onboarding wizard screen fails the task instead of hanging
- **WHEN** a `claude-code` task's rolling output contains both `Welcome to Claude Code`
  and `Select login method`
- **THEN** the output is classified `runtime_auth_rejected` and the task fails with the
  `reconnect_runtime` action

#### Scenario: Quoted fragments do not classify
- **WHEN** the rolling output merely quotes one wizard anchor in prose (for example a
  transcript line mentioning `Select login method` without the welcome banner) or
  mentions `API Error: 401` inside a longer prose paragraph rather than as a standalone
  status line
- **THEN** no auth failure is classified and the task continues running

#### Scenario: Existing classifications are preserved
- **WHEN** rolling output matches the previously recognized shapes (standalone
  `Invalid API key · Please run /login`, session-expired lines, or the JSON
  `authentication_error` envelope adjacent to `API Error: 401`)
- **THEN** they classify exactly as before this change
