<!-- Retroactive change record for the OpenSpec-CLI-bake fix shipped in 062335e.
     All work was done + verified before this record was authored; tasks reflect
     the as-shipped reality. -->

## 1. Track: bake-and-wire (depends: none)

- [x] 1.1 Bake the `openspec` CLI into `docker/aio-sandbox.Dockerfile` as root (`ARG OPENSPEC_VERSION=1.4.1`, `npm install -g @fission-ai/openspec@${OPENSPEC_VERSION} && openspec --version`), mirroring the Codex CLI bake — lands `/usr/bin/openspec` on PATH for the gem-run codex process.
- [x] 1.2 Switch the skill allowlist's OpenSpec entry (`apps/api/src/sandbox/skill-allowlist.ts`) from `npx -y @fission-ai/openspec init` to the baked `openspec init --tools codex --force <ws>` (single version source; no per-task npx fetch). BMAD left on npx (self-contained skills, not baked).
- [x] 1.3 Update the provider test assertion (`openspec` skill now runs baked `openspec init`, not `@fission-ai/openspec`).
- [x] 1.4 Correct the `aio-sandbox-execution` "Selected skills…" spec requirement (baked-CLI requirement + workspace-level `.codex/skills`).

## 2. Track: verify (depends: bake-and-wire)

- [x] 2.1 Static gates: api `tsc` (0), provider test 47/47, eslint (0), nest build (0).
- [x] 2.2 Live (post-deploy): confirmed the `cap-aio-sandbox:pinned` image rebuilt with `/usr/bin/openspec` baked; on real task `1cb444cc` codex read the openspec-explore SKILL.md, ran `openspec list` → `No active changes found`, and confirmed the CLI is usable. OpenSpec preinstall closed end-to-end.
