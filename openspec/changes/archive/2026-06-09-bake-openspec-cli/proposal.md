## Why

The `task-preinstall-skills` change shipped OpenSpec preinstall as half-complete: `npx -y @fission-ai/openspec init` dropped the `.codex/skills/*/SKILL.md` files, but those skills shell out to the `openspec` CLI at runtime (`openspec status`/`list`/`instructions`/`new` — 15+ call sites) and the CLI was NOT on the sandbox PATH, so every OpenSpec skill failed with `openspec: command not found`. (Live-confirmed: a real task selecting OpenSpec — `019e3d6b` — failed for this reason.) This is a retroactive change record for the fix shipped in commit `062335e`.

## What Changes

- **Bake the `openspec` CLI into the derived sandbox image.** The `/v1/shell/exec` provision channel runs as the unprivileged `gem` user (uid 1000), which cannot `npm install -g` to the root-owned `/usr` prefix — so a runtime per-task global install is impossible. Instead the CLI is baked at image-build time as root (`docker/aio-sandbox.Dockerfile`, `ARG OPENSPEC_VERSION=1.4.1`, `npm install -g @fission-ai/openspec@... && openspec --version`), landing `/usr/bin/openspec` on PATH for the codex process — mirroring the existing Codex CLI bake.
- **Per-task installer uses the baked CLI.** The skill allowlist's OpenSpec entry now runs `openspec init --tools codex --force <ws>` (the baked CLI) instead of `npx -y @fission-ai/openspec init`, so the CLI version that scaffolds the workspace and the CLI the skills invoke at runtime are one and the same (single version source = the Dockerfile pin); no per-task npx fetch.
- **BMAD is NOT baked.** Its 171 installed skills are self-contained agent personas with no hard `bmad` CLI runtime dependency (only a cosmetic `bmad help` reference in one skill).
- **Spec correction (folded in):** the `aio-sandbox-execution` "Selected skills are preinstalled…" requirement is corrected to state the baked-CLI requirement and that skills land in the workspace-level `.codex/skills` (not `~/.codex/skills`, the earlier wrong assumption).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `aio-sandbox-execution`: the **Selected skills are preinstalled into the task workspace at provision time** requirement is refined — when a skill's generated SKILL.md shells out to that skill's CLI (OpenSpec → `openspec`), the CLI SHALL be baked into the image (the gem-user provision channel cannot global-install), and the per-task installer uses the baked CLI; skills land in the workspace-level `.codex/skills`.

## Impact

- **Code:** `docker/aio-sandbox.Dockerfile` (bake openspec CLI, `OPENSPEC_VERSION`), `apps/api/src/sandbox/skill-allowlist.ts` (OpenSpec → baked `openspec init`), `apps/api/src/sandbox/aio-sandbox.provider.test.mjs` (assertion updated). All shipped in `062335e`.
- **Deploy:** changes the Dockerfile, so `cap-aio-sandbox:pinned` must be rebuilt (compose `up --build`) — verified rebuilt with `/usr/bin/openspec` baked.
- **Specs:** `openspec/specs/aio-sandbox-execution/spec.md` (MODIFIED delta; already synced in `062335e`).
- **Live verification:** PASSED on real task `1cb444cc` — codex read `SKILL.md (openspec-explore skill)`, ran `openspec list` → `No active changes found`, and confirmed "openspec list 可以用". This closes the OpenSpec preinstall end-to-end.
