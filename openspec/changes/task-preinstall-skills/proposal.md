## Why

When creating a task, the operator should be able to select reusable agent skills/methods (e.g. **OpenSpec** or **BMAD**) to preinstall into the task sandbox, so codex starts already equipped with that workflow instead of the operator bootstrapping it by hand each time. Today the sandbox bakes only codex + hooks, and provision injects only auth/config/prompt; there is no notion of a selectable preinstalled skill.

## What Changes

- **Persist the operator's skill selection on the task (inert run parameter).** Add an OPTIONAL `skills` field to `Task` + `CreateTaskRequest`, modeled exactly like the existing inert `branch`/`strategy` parameters (persisted, echoed on every read path, NEVER gating lifecycle).
- **Preinstall selected skills into the workspace at provision time.** After the repo clone (and reusing the existing connect-in provision step pattern), the orchestrator SHALL run each selected skill's official non-interactive installer against the cloned workspace — verified forms: OpenSpec via `npx -y @fission-ai/openspec init --tools codex --force <workspace>` (the `--tools` list natively includes `codex`), BMAD via `npx bmad-method install --directory <workspace> --modules <…> --tools <…> --yes`. codex then picks the skill up through the agent-instruction files the installer generates (AGENTS.md and/or `~/.codex/skills/<name>/SKILL.md`, both confirmed real codex 0.131 discovery mechanisms — see design). Skill set membership is from a server-side ALLOWLIST of known installers (operator free-text is NOT executed).
- **Offer the skill picker in the new-task form.** Add a multi-select skill picker to the shared create form (mirroring the existing `strategy` select), submitting the chosen skill ids in the create body and reflecting them in the command preview.
- **Fail-soft on skill install (NOT fail-closed).** Unlike auth/clone, a skill-installer failure SHALL NOT fail the whole provision — the task still launches codex (without that skill), and the failure is surfaced (logged + reflected on the task), because a missing skill is a degraded-but-usable session, not a security gate.

## Capabilities

### New Capabilities

None. (A future change MAY extract a dedicated `task-skills` capability if the catalog grows; for now this extends existing capabilities.)

### Modified Capabilities

- `aio-sandbox-execution`: the **codex launched in-shell** requirement gains an optional per-task skill-preinstall step at provision time (run the selected skills' allowlisted non-interactive installers against the cloned workspace, reusing the existing exec-injection pattern), fail-SOFT, so codex starts already equipped with the chosen workflow. The skill text is from a server-side allowlist, never raw operator input executed as a command.
- `repo-and-task-management`: the **Postgres + Prisma data model** and **REST API for tasks** requirements gain an OPTIONAL `skills` run parameter on `Task` + `CreateTaskRequest`, persisted and echoed on every read path, modeled as inert exactly like `branch`/`strategy` (no lifecycle effect).
- `frontend-console`: the **New task creation** requirement gains a skill multi-select picker in the shared create form, submitted in the create body and shown in the command preview.

## Impact

- **Code (api):** Prisma `Task.skills` column (+ migration); `CreateTaskRequest`/`TaskResponse` contracts gain `skills?`; `AioSandboxProvider` adds a `preinstallSkills` provision step (after clone) driven by a server-side skill→installer-command allowlist, run via the existing `/v1/shell/exec` pattern, fail-soft; `ProvisionLookup` returns the task's selected skills (like `getTaskPrompt`).
- **Code (web):** new-task form skill multi-select; create body + command preview updated.
- **Image:** Node/npx is already present in the AIO base; if cold `npx` fetches prove slow/unreliable, an OPTIONAL Dockerfile prefetch of the known skill packages is a follow-up (not required for v1).
- **Specs:** `aio-sandbox-execution`, `repo-and-task-management`, `frontend-console` deltas.
- **Research status:** codex extension mechanisms + openspec/bmad installers were VERIFIED first-hand (codex 0.131 binary strings + npm) — see research-brief. Remaining LIVE spikes (in design Open Questions): does the installer run cleanly inside a real `cap-aio` sandbox (network egress to npm/GitHub, runtime, GH auth for private skill repos)? does BMAD's `--tools` support `codex` (OpenSpec confirmed)? which exact files each installer drops and whether codex 0.131 actually reads them end-to-end.
