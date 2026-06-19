## MODIFIED Requirements

### Requirement: Provision-time trust and onboarding pre-seed
At provision time the runtime SHALL pre-seed the Claude global config file that Claude
actually reads — **`$HOME/.claude.json`** (the sandbox HOME root, e.g. `/home/gem/.claude.json`),
NOT `$CLAUDE_CONFIG_DIR/.claude.json` — with the GLOBAL onboarding keys (`theme`,
`hasCompletedOnboarding`) AND the per-project trust entry
(`projects[<canonicalized-workspace>].hasTrustDialogAccepted = true`,
`hasCompletedProjectOnboarding = true`), because the per-project trust entry alone does NOT
suppress the first-run global theme/onboarding screen. `CLAUDE_CONFIG_DIR` relocates only the
`.claude` DIRECTORY (settings, cache, `projects/` transcripts); the main `.claude.json` stays
at the HOME root regardless, so seeding it inside `$CLAUDE_CONFIG_DIR` is ignored (Claude
creates a fresh un-onboarded `$HOME/.claude.json` and runs the full onboarding). This is the
Claude analog of codex's `config.toml` trust step.

#### Scenario: First interactive launch is not blocked by onboarding
- **WHEN** Claude starts for the first time in the sandbox HOME with the pre-seed present
- **THEN** no theme-selection or onboarding screen appears and the prompt auto-runs

#### Scenario: Pre-seed targets the HOME-root config Claude reads
- **WHEN** the runtime emits the provision-time pre-seed for a `claude-code` task
- **THEN** the `.claude.json` carrying `theme` + `hasCompletedOnboarding` is written to the
  sandbox HOME root (`$HOME/.claude.json`), which is the file Claude reads on startup —
  not `$CLAUDE_CONFIG_DIR/.claude.json`

#### Scenario: Skipping onboarding lets the injected token authenticate without a prompt
- **WHEN** the HOME-root pre-seed marks `hasCompletedOnboarding:true` and `CLAUDE_CODE_OAUTH_TOKEN`
  is injected
- **THEN** Claude skips the entire onboarding flow (theme AND auth) and authenticates with the
  injected token, with no `/login` or token prompt
