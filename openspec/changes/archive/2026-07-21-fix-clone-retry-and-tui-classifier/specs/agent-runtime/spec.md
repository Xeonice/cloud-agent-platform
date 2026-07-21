# agent-runtime — delta for fix-clone-retry-and-tui-classifier

## MODIFIED Requirements

### Requirement: Claude auth-failure classification covers current CLI phrasings
`classifyClaudeOutputFailure` SHALL classify, in addition to its existing patterns,
(a) the inline TUI auth-error line emitted by current claude versions — a single
terminal line carrying both a `/login` instruction and an `API Error: 401`-class
rejection (e.g. `● Please run /login · API Error: 401 Invalid bearer token`, or the
`OAuth access token is invalid` variant) — as
`runtime_auth_rejected` (or `runtime_auth_expired` when the same line shape carries an
expired-token message), and (b) the first-run onboarding wizard screen — identified by
the co-occurrence of the stable anchors `Welcome to Claude Code` AND
`Select login method` in the rolling output window — as `runtime_auth_rejected`,
because a visible wizard means onboarding suppression failed and the task can never
proceed without interactive input.

Classification SHALL be effective on the RAW interactive TUI byte stream, in which
claude paints screen rows via absolute cursor positioning and cursor movement with no
newline delimiters: output normalization SHALL convert absolute cursor positioning
and vertical cursor-movement sequences into line breaks and horizontal
cursor-movement sequences into spaces BEFORE stripping remaining ANSI sequences, so
that visually distinct screen rows become distinct lines for the line-anchored
patterns. Codex classification behavior SHALL remain unchanged by this
normalization. The classifier's fixture for the inline auth-error line SHALL be the
real captured PTY byte stream of a production session, not rendered/capture-pane
text.

Both classifications SHALL be narrow: the inline
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

#### Scenario: Real cursor-positioned TUI bytes classify

- **WHEN** the rolling output is the raw PTY byte stream of a claude TUI session whose
  visible screen carries `● Please run /login · API Error: 401 OAuth access token is
  invalid.` painted via cursor-positioning sequences with no newlines (the captured
  production session fixture)
- **THEN** the output is classified `runtime_auth_rejected`

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
  `authentication_error` envelope adjacent to `API Error: 401`), or codex output
  matches any established codex pattern
- **THEN** they classify exactly as before this change
