## ADDED Requirements

### Requirement: Provisioning and teardown delegate to the selected AgentRuntime
Per-task provisioning and pre-stop teardown SHALL delegate credential/config injection
and the launch command to the task's selected `AgentRuntime` (see `agent-runtime`)
instead of hard-coding codex auth.json + codex launch. For a `codex` task the behavior
SHALL be unchanged (inject `/home/gem/.codex/auth.json` + `config.toml`, trim
`/home/gem/.codex` and clear `auth.json` before stop). For a `claude-code` task,
provisioning SHALL instead inject the Claude credential as the `CLAUDE_CODE_OAUTH_TOKEN`
launch env (no auth file) and pre-seed `/home/gem/.claude/.claude.json` (global
onboarding + per-project trust), and the pre-stop trim SHALL target `/home/gem/.claude`
(removing cached/credential state while keeping the session transcript under
`/home/gem/.claude/projects/`) as the defense-in-depth analog of the codex trim. A
pre-stop trim failure SHALL NOT block the stop+retain.

#### Scenario: Codex provisioning/teardown is unchanged
- **WHEN** a `codex` task is provisioned and later torn down
- **THEN** auth.json/config.toml are injected and the `/home/gem/.codex` trim + auth.json
  clear run before stop, exactly as before

#### Scenario: Claude provisioning injects an env token and pre-seed, not an auth file
- **WHEN** a `claude-code` task is provisioned
- **THEN** the launch env carries `CLAUDE_CODE_OAUTH_TOKEN`, `/home/gem/.claude/.claude.json`
  is pre-seeded with global onboarding + per-project trust, and no `~/.codex/auth.json`
  is written

#### Scenario: Claude pre-stop trim targets the Claude HOME and keeps the transcript
- **WHEN** a `claude-code` task reaches a terminal state and the container is stopped+retained
- **THEN** `/home/gem/.claude` cached/credential state is trimmed while
  `/home/gem/.claude/projects/<slug>/<session-id>.jsonl` is kept, and a trim failure does
  not block the stop

### Requirement: The derived AIO image bakes a pinned Claude Code CLI
The derived AIO Sandbox image SHALL bake the Claude Code CLI at a PINNED version
alongside the pinned codex CLI (never `latest`), because the Claude launch relies on
`CLAUDE_CODE_SANDBOXED` and onboarding-suppression flags that are undocumented binary
internals and must not drift. The image SHALL be able to launch a `claude-code` task
without installing the CLI at provision time.

#### Scenario: Claude is present at a pinned version in the image
- **WHEN** the derived image is built and a `claude-code` task starts
- **THEN** `claude --version` reports the pinned version and no runtime install step is needed
