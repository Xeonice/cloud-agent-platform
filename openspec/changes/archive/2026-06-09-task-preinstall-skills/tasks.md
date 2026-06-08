<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: live-spike (depends: none)

<!-- Resolve the design Open Questions on a real sandbox BEFORE locking the installer commands. -->

- [x] 1.1 openspec init in a real sandbox. — `npx -y @fission-ai/openspec@latest init --tools codex --force . < /dev/null`: EXIT 0, ~6s, non-interactive; drops `openspec/` + `.codex/skills/<name>/SKILL.md` ×5. Egress (npm+GitHub) confirmed on bridge AND cap-net. (design.md "Live spike results")
- [x] 1.2 BMAD codex support. — `--list-tools` confirms native `codex` id → target `.agents/skills`; `npx -y bmad-method@latest install --directory . --modules bmm --tools codex --yes < /dev/null`: EXIT 0, ~3s, installs `_bmad/` + 44 skills → `.agents/skills`.
- [x] 1.3 codex discovery path + prefetch decision. — codex 0.131 binary references repo-level `.codex/skills` AND `.agents/skills` (in scope via `-C /home/gem/workspace`); corrected the earlier `~/.codex/skills` assumption. Cold npx 3–6s with egress → NO Dockerfile prefetch needed for v1. (Whether codex SURFACES them in a live authed session is the one deferred check — needs ChatGPT auth, moved to Open Questions / apply.)
- [x] 1.4 Allowlist locked in design.md: openspec + bmad pinned non-interactive installer argv, workspace target, `< /dev/null` (no TTY), per-skill target dirs (.codex/skills vs .agents/skills).

## 2. Track: contracts-and-schema (depends: live-spike)

- [x] 2.1 Added OPTIONAL `skills` to `CreateTaskRequest` (`z.array(z.string().min(1)).optional()`) + `TaskSchema`/`TaskResponse` (`.nullable().optional()`) in `@cap/contracts`, mirroring branch/strategy.
- [x] 2.2 Added `Task.skills String[] @default([])` (Postgres text[]) to the Prisma schema + migration `20260609000000_add_task_skills`; `tasks.service.create` persists `body.skills ?? []`, `toResponse` echoes it on every read path. Inert (no lifecycle effect).
- [x] 2.3 `packages/contracts/src/task-skills.test.mjs` (6/6): skills round-trips through CreateTaskRequest/TaskResponse; omitted reads back undefined/[]; empty-string id rejected; accepted under every status (inert vs lifecycle).

## 3. Track: provision-preinstall (depends: contracts-and-schema)

- [x] 3.1 Added `getTaskSkills(taskId)` to the `ProvisionLookup` port + `PrismaProvisionLookup` (mirrors `getTaskPrompt`), returns selected ids or `[]`.
- [x] 3.2 `apps/api/src/sandbox/skill-allowlist.ts`: server-side `SKILL_ALLOWLIST` (openspec/bmad → pinned non-interactive installer argv from the Track 1 spike) + `resolveSkillInstaller`/`isAllowlistedSkill`; only allowlisted ids are ever built into a command.
- [x] 3.3 `AioSandboxProvider.preinstallSkills` runs AFTER `cloneTaskRepository`: per selected allowlisted skill, runs its pinned argv (`+ < /dev/null`) against `WORKSPACE_DIR` via `/v1/shell/exec`, each bounded by `SKILL_INSTALL_TIMEOUT_MS` (120s) via `AbortSignal.timeout`; skills install independently.
- [x] 3.4 FAIL-SOFT: non-allowlisted id skipped (never executed); HTTP error / non-zero exit / timeout is logged ("degrading (codex launches without it)") and skipped, NEVER aborting provision (NOT in the fail-closed try/throw of auth/clone); method swallows all its own errors.
- [x] 3.5 `aio-sandbox.provider.test.mjs` (now 47/47): allowlisted skills run their pinned commands against the workspace; non-allowlisted id never serialized into a command; a failing installer is fail-soft (provision still returns the handle); empty selection is a no-op.

## 4. Track: web-skill-picker (depends: contracts-and-schema)

- [x] 4.1 `SKILL_CATALOG` (exported from new-task-dialog, ids matching the server allowlist) + a Checkbox multi-select skill picker in BOTH the dashboard modal and `/tasks/new` (mirrors the strategy control).
- [x] 4.2 Selected `skills` submitted in the create body (`if (skills.length) body.skills = skills`) and reflected in `buildCommandPreview` (`--skills a,b`); empty selection preserves prior behavior.

## 5. Track: verify (depends: provision-preinstall, web-skill-picker)

- [x] 5.1 Static gates GREEN: api + web `tsc` (0), nest + vite build (0), full api suite (provider 47/47 incl 4 skill blocks; contracts task-skills 6/6; no regression), web vitest 40/40, eslint on changed api/web/contracts files (0).
- [ ] 5.2 Live (post-deploy, needs ChatGPT auth): create a task with OpenSpec selected; confirm provision runs the installer, the workspace gets `.codex/skills`, codex surfaces the skills (e.g. `/skills`), and a deliberately-broken skill install degrades (codex still launches) instead of failing the task.
