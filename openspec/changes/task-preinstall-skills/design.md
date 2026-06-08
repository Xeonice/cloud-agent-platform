## Context

First-hand verified (codex 0.131 binary `strings` + live sandbox probe + npm), NOT just web research:
- **codex 0.131 extension surfaces** (real): (1) **AGENTS.md** — the binary embeds the full "AGENTS.md spec": repo AGENTS.md files, scope = the directory subtree, nested overrides, the root AGENTS.md is auto-included with the developer message. (2) **Skills** — `~/.codex/skills/<name>/SKILL.md` is auto-discovered; there is a `/skills` slash command, an `init_skill.py`, a built-in `$CODEX_HOME/skills/.system/imagegen`, and a skill installer (`DEFAULT_REPO=openai/skills`, installs from a curated list or any GitHub repo path). (3) **Plugins** — a MARKETPLACE model (`codex plugin add/list/marketplace`, `.codex-plugin/plugin.json`), heavier, NOT a drop-a-local-json model. (4) **MCP** — `config.toml [mcp_servers]`. (Hallucination corrected from the initial web pass: there is no `codex plugin install` (it is `add`); plugins are marketplace-based, not local manifests.)
- **OpenSpec** = npm `@fission-ai/openspec@1.4.1` (bin `openspec`). Non-interactive install verified: `npx -y @fission-ai/openspec init --tools codex --force <path>` — the `--tools` flag's documented list NATIVELY includes `codex` (also amazon-q, claude, cursor, gemini, copilot, opencode, windsurf, …). Also has `update`/`archive`/`initiative`.
- **BMAD** = npm `bmad-method@6.8.0` (bin `bmad`/`bmad-method`, "Breakthrough Method of Agile AI-driven Development"). Non-interactive verified from the package README: `npx bmad-method install --directory <path> --modules bmm --tools <ide> --yes` (the README's CI/CD example uses `--tools claude-code`; whether `--tools` accepts `codex` is UNCONFIRMED).
- **Existing infra to reuse**: provision already (a) git-clones the repo into `/home/gem/workspace`, (b) injects files via `printf %s '<base64>' | base64 -d > file` over `/v1/shell/exec` (config.toml/auth.json/task-prompt.txt), (c) treats `branch`/`strategy` as inert persisted run params echoed on every read path. codex in-sandbox execution is NOT gated (the container is the trust boundary), so running an installer at provision time is consistent with the threat model.

## Goals / Non-Goals

**Goals:**
- Operator can select one or more skills (OpenSpec, BMAD, …) when creating a task; codex starts already equipped.
- Reuse the existing clone + exec-injection infra; add a Task run-param modeled like branch/strategy.
- A skill that fails to install degrades the session (no skill) rather than failing the task.

**Non-Goals:**
- A skill marketplace / arbitrary operator-supplied installers (v1 is a fixed server-side allowlist; raw free-text is never executed).
- codex plugin (marketplace) integration — too heavy for per-task preinstall.
- Resource/history work (sibling change `console-task-metrics-and-navigation`).
- Persisting installer output/logs beyond a pass/fail signal.

## Decisions

- **D1 — `skills` is an inert Task run parameter, modeled on branch/strategy.** Add OPTIONAL `Task.skills` (a string list — comma-joined column or JSON) + `CreateTaskRequest.skills?` + echo on every read path. It MUST NOT gate any lifecycle transition (same inert guarantee branch/strategy carry). `ProvisionLookup.getTaskSkills(taskId)` returns it (mirrors `getTaskPrompt`), keeping the provider a pure port consumer.
- **D2 — Preinstall via an allowlisted installer command run against the cloned workspace, after clone.** A server-side map `skillId → installer argv` (e.g. `openspec → npx -y @fission-ai/openspec init --tools codex --force <WORKSPACE>`, `bmad → npx -y bmad-method install --directory <WORKSPACE> --tools <…> --yes`). The provider runs each selected skill's command over `/v1/shell/exec` AFTER `cloneTaskRepository`. The operator only ever submits skill IDS (validated against the allowlist); the actual command text is server-defined, so no operator free-text reaches the shell. Alternative (inject hand-written AGENTS.md/SKILL.md ourselves) rejected as a v1 default — the official installers generate the correct, versioned files and keep us out of the business of mirroring each tool's format; we MAY add a "lite/AGENTS.md-only" mode later.
- **D3 — Fail SOFT, not closed.** A non-zero installer exit logs + records a per-task "skill X failed to preinstall" signal but does NOT abort provision — codex still launches (without that skill). This is the opposite of auth/clone (which fail closed) because a missing skill is degraded-but-usable, not a security hole. Each skill installs independently (one failing does not block the others).
- **D4 — codex consumes skills via the files the installer drops.** No codex-side wiring needed beyond what exists: AGENTS.md at the workspace root is auto-included; `~/.codex/skills/<name>/SKILL.md` is auto-discovered. We do NOT use the codex plugin marketplace. (Which of AGENTS.md vs SKILL.md a given installer produces is per-tool; both are codex-discovered, so either works.)
- **D5 — Frontend multi-select mirrors the strategy select.** The create form gains a skill multi-select (options from a small static catalog matching the server allowlist), submitting `skills: string[]` and reflecting the choice in the command preview. Empty selection = today's behavior (no preinstall).

## Risks / Trade-offs

- **Installer needs network egress (npm + maybe GitHub) from inside `cap-aio`** → the sandbox is on `cap-net` with no host port; outbound egress for `npx` must work. If egress is restricted or slow, cold `npx` fetch could be slow/fail. Mitigation: D3 fail-soft; an OPTIONAL Dockerfile prefetch/bake of the known skill packages removes the cold-fetch (follow-up, not v1-blocking). [LIVE SPIKE]
- **BMAD `--tools codex` support unconfirmed** → OpenSpec confirmed; BMAD README example is `claude-code`. Mitigation: confirm via spike; if BMAD lacks a codex target, ship OpenSpec first and either use BMAD's generic output or defer BMAD. [LIVE SPIKE]
- **Private skill repos / auth** → the GitHub-path skill installer or a private BMAD module could need credentials; v1 allowlist should only include skills installable without extra secrets. [LIVE SPIKE]
- **Installer wall-clock adds to provision latency** → runs after clone, before the session is useful; bound it with a timeout and run selected skills concurrently where safe. Fail-soft on timeout.
- **Version drift** → `@latest`/unpinned `npx` could change behavior; pin the skill installer versions in the allowlist for reproducibility (mirror the codex version-pin discipline).

## Migration Plan

- Additive: a nullable `Task.skills` column (Prisma migration), optional contract field, an optional provision step that no-ops when no skills are selected. Deploy api via dokploy, web via Vercel.
- Rollback: drop the provision step + the picker; the column can remain unused (nullable) or be reverted.

## Open Questions (LIVE SPIKES before/within apply)

- Does `npx -y @fission-ai/openspec init --tools codex --force <workspace>` run cleanly inside a real `cap-aio` sandbox (network egress, runtime, no TTY)? What files does it drop, and does codex 0.131 actually read them in a session?
- Does `bmad-method install` support a `--tools codex` target? What does it drop, and is it codex-readable?
- Egress/latency of cold `npx` from inside the sandbox — is a Dockerfile prefetch needed for v1 UX?
- Storage shape for `skills` (comma-joined string like a single column vs JSON array) — match whatever is least friction with the existing inert-param read path.
- Catalog/allowlist location + shape (static const vs config) and how the frontend catalog stays in sync with the server allowlist.
