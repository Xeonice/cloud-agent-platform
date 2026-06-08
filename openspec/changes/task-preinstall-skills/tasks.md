<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: live-spike (depends: none)

<!-- Resolve the design Open Questions on a real sandbox BEFORE locking the installer commands. -->

- [ ] 1.1 In a real `cap-aio` sandbox, run `npx -y @fission-ai/openspec init --tools codex --force /home/gem/workspace` and record: does it complete with no TTY, what files it drops (AGENTS.md? openspec/? a codex skill dir?), wall-clock, and any network-egress failure.
- [ ] 1.2 In a real sandbox, determine BMAD's codex support: `npx -y bmad-method install --help` (or docs) — does `--tools` accept a codex target? If yes, run it non-interactively and record dropped files; if no, record the fallback (generic output / AGENTS.md / defer BMAD).
- [ ] 1.3 Confirm codex 0.131 actually READS the dropped files in a live session (AGENTS.md auto-included / `~/.codex/skills/<name>/SKILL.md` discovered). Decide whether a Dockerfile prefetch of the skill packages is needed for acceptable provision latency.
- [ ] 1.4 Lock the server-side skill→installer allowlist (skill id, pinned installer argv, which workspace path, expected dropped files) from 1.1–1.3 findings; record it in design.md.

## 2. Track: contracts-and-schema (depends: live-spike)

- [ ] 2.1 Add OPTIONAL `skills` to `CreateTaskRequest` + `TaskResponse`/`Task` in `@cap/contracts` (a string array; shape per the inert-param read path), agreeing create-body and response shapes (mirror branch/strategy).
- [ ] 2.2 Add a nullable `Task.skills` column to the Prisma schema (+ migration), modeled inert like `branch`/`strategy` (no lifecycle effect); persist from the create body and echo on create/list/fetch read paths.
- [ ] 2.3 Unit-cover: skills round-trips write/read in the DB; omitted skills read back as empty/null (never fabricated); the task lifecycle is unaffected by skills.

## 3. Track: provision-preinstall (depends: contracts-and-schema)

- [ ] 3.1 Add `getTaskSkills(taskId)` to the `ProvisionLookup` port + `PrismaProvisionLookup` (mirror `getTaskPrompt`), returning the selected skill ids (or empty).
- [ ] 3.2 Add a server-side skill→installer allowlist (from Track 1) in the api (static const), validating that only allowlisted skill ids are ever executed.
- [ ] 3.3 In `AioSandboxProvider`, add a `preinstallSkills` step AFTER `cloneTaskRepository`: for each selected (allowlisted) skill, run its pinned installer argv against `/home/gem/workspace` via `/v1/shell/exec`. Run independently per skill; bound each with a timeout.
- [ ] 3.4 Fail SOFT: a non-zero/timed-out installer logs + records a per-task "skill X failed to preinstall" signal but does NOT abort provision (codex still launches). One skill failing does not block the others. (Contrast with auth/clone fail-closed.)
- [ ] 3.5 Unit-cover the provision step: selected allowlisted skills run their pinned commands against the workspace; a non-allowlisted id is never executed; an installer failure is swallowed (provision proceeds, signal recorded); empty selection is a no-op.

## 4. Track: web-skill-picker (depends: contracts-and-schema)

- [ ] 4.1 Add a static skill catalog to `apps/web` (matching the server allowlist ids/labels) and a multi-select skill picker in the shared new-task form (mirror the `strategy` select), in BOTH the dashboard modal and `/tasks/new`.
- [ ] 4.2 Submit chosen `skills` in the create body and reflect them in the `CommandPreview`; empty selection preserves today's behavior.

## 5. Track: verify (depends: provision-preinstall, web-skill-picker)

- [ ] 5.1 Static gates: api + web `tsc`, nest build, web vitest, eslint on changed files; new unit tests green.
- [ ] 5.2 Live: create a task with OpenSpec selected; confirm provision runs the installer, the workspace gets the skill files, codex starts already aware of the workflow, and a deliberately-broken skill install degrades (codex still launches) instead of failing the task.
