# Research brief — task-preinstall-skills

Side-car provenance. First-hand verified (codex 0.131 binary `strings` + live `cap-aio` probe + npm), after an initial web pass whose hallucinations were corrected by the real-machine check.

## codex 0.131 extension mechanisms (binary strings — ground truth)

- **AGENTS.md** (rock-solid): binary embeds the full "AGENTS.md spec" — repo AGENTS.md files, scope = directory subtree, nested overrides, root AGENTS.md auto-included with the developer message. There is a `/` command "create an AGENTS.md file".
- **Skills** (real — my initial "hallucination" call was WRONG, corrected): `~/.codex/skills/<name>/SKILL.md` auto-discovered; `/skills` slash command; `init_skill.py`; built-in `$CODEX_HOME/skills/.system/imagegen`; a skill installer with `DEFAULT_REPO=openai/skills` that installs from a curated list or any GitHub repo path.
- **Plugins** (real but heavy): MARKETPLACE model — `codex plugin add/list/marketplace`, `.codex-plugin/plugin.json`, "plugin/install requires marketplacePath or remoteMarketplaceName". NOT a drop-a-local-json model. Corrected hallucination: there is no `codex plugin install` (it is `add`).
- **MCP**: `config.toml [mcp_servers]`.
- Top-level `codex --help` (0.131.0) confirms subcommands: exec, mcp, plugin, etc. No top-level `skill` subcommand (skills go through `/skills` + file discovery).

## openspec / bmad (npm — verified)

- **openspec** = `@fission-ai/openspec@1.4.1`, bin `openspec`, "AI-native system for spec-driven development". `openspec init --help` (verified): `--tools <list>` where the list NATIVELY INCLUDES `codex` (+ amazon-q, claude, cursor, gemini, github-copilot, opencode, windsurf, …), `--force` auto-cleanup non-interactive, `--profile`. Also `update`/`archive`/`initiative` commands. → `npx -y @fission-ai/openspec init --tools codex --force <workspace>`.
- **bmad** = `bmad-method@6.8.0`, bin `bmad`/`bmad-method`, "Breakthrough Method of Agile AI-driven Development". README non-interactive example: `npx bmad-method install --directory /path --modules bmm --tools claude-code --yes`. Whether `--tools` accepts a `codex` target is UNCONFIRMED (README example uses claude-code).

## Existing infra reused

provision already git-clones into `/home/gem/workspace` and injects files via `printf %s '<base64>' | base64 -d > file` over `/v1/shell/exec`; `branch`/`strategy` are inert persisted run params echoed on every read path; codex in-sandbox execution is NOT gated (container = trust boundary), so running an installer at provision time fits the threat model.

## Still needs LIVE spike (design Open Questions / tasks Track 1)

- Does `npx -y @fission-ai/openspec init --tools codex --force <workspace>` run cleanly inside a real `cap-aio` sandbox (network egress to npm, no TTY)? What files does it drop, and does codex 0.131 read them end-to-end?
- Does `bmad-method install` support a `--tools codex` target?
- Cold-`npx` egress/latency from inside the sandbox — is a Dockerfile prefetch needed for v1?
- Private skill repos / auth — keep v1 allowlist to no-extra-secret skills.

## Process note

The research workflow's verify phase stalled (search-specialist agents timed out); the research-phase StructuredOutput survived in subagent transcripts and was salvaged, then de-hallucinated by the real-machine probe + npm checks above. Net: load-bearing claims here are first-hand, not unverified web output.
