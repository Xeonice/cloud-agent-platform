## ADDED Requirements

### Requirement: Selected skills are preinstalled into the task workspace at provision time
When a task selects one or more skills (the optional `skills` run parameter — see `repo-and-task-management`), the orchestrator SHALL preinstall each selected skill into the cloned task workspace at provision time, AFTER the repo clone and BEFORE the codex launch handle is returned, so codex starts already equipped with that workflow. Each skill SHALL be installed by running its OFFICIAL non-interactive installer against `/home/gem/workspace` over the existing `/v1/shell/exec` channel (the same surface used for clone/auth injection) — for example OpenSpec via `npx -y @fission-ai/openspec init --tools codex --force /home/gem/workspace`. The set of installable skills SHALL be a SERVER-SIDE ALLOWLIST mapping a skill id to a fixed, pinned installer command; the operator only ever submits skill IDS, which the orchestrator validates against the allowlist — raw operator free-text SHALL NEVER be executed as an installer command. codex SHALL consume the preinstalled skill through the agent-instruction files the installer drops into the workspace (a root `AGENTS.md`, auto-included with the developer message, and/or a `~/.codex/skills/<name>/SKILL.md`, auto-discovered) — the codex plugin MARKETPLACE is NOT used for per-task preinstall.

Skill preinstall SHALL FAIL SOFT, in deliberate contrast to the fail-CLOSED auth/clone steps: a skill whose installer exits non-zero or times out SHALL be logged and recorded as a per-task "skill failed to preinstall" signal, but SHALL NOT abort the provision — codex SHALL still launch (without that skill), because a missing skill is a degraded-but-usable session, not a security gate. Each selected skill SHALL install independently, so one skill failing does not block the others. When a task selects no skills, the preinstall step SHALL be a no-op and provision behavior SHALL be unchanged.

#### Scenario: A selected allowlisted skill is installed into the workspace before launch
- **WHEN** a task selecting the `openspec` skill is provisioned
- **THEN** after the repo clone the orchestrator runs the allowlisted OpenSpec installer (`npx -y @fission-ai/openspec init --tools codex --force /home/gem/workspace`) against the workspace, and codex then launches with the skill's generated instruction files present

#### Scenario: Only allowlisted skill ids are ever executed
- **WHEN** a task's `skills` selection contains an id not in the server-side allowlist
- **THEN** the orchestrator does NOT execute any command for that id (no operator free-text reaches the shell as an installer command)

#### Scenario: A failing skill install degrades rather than failing the task
- **WHEN** a selected skill's installer exits non-zero or times out
- **THEN** the orchestrator logs and records a per-task "skill failed to preinstall" signal but still launches codex (without that skill), and any other selected skills still install

#### Scenario: No skills selected is a no-op
- **WHEN** a task selects no skills
- **THEN** the provision runs no skill installer and behaves exactly as before this change
