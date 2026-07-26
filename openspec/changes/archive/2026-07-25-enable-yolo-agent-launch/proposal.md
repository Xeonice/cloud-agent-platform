## Why

Operators need interactive and programmatic task agents to run unattended inside an
already isolated, per-task sandbox. The previous launch policy was inconsistent:
Codex headless execution used its explicit bypass flag while interactive Codex and
Claude Code could still stop on approval prompts. That made routine repository work,
including `git`, unreliable as an online task experience.

The sandbox-provider refactor also moved the live terminal mechanism out of API-local
AIO code. This change therefore has to describe one provider-neutral runtime policy,
not revive deleted `AioPtyClient` or AIO-only launch helpers.

## What Changes

- Launch interactive Codex with
  `--dangerously-bypass-approvals-and-sandbox`.
- Launch interactive, headless, and headless-resume Claude Code with
  `--dangerously-skip-permissions`.
- Pre-seed Claude Code user settings with
  `permissions.skipDangerousModePermissionPrompt=true`, in addition to the existing
  two-path onboarding/trust pre-seed.
- Keep prompt material file-backed and shell-injection-safe, and keep detached tmux,
  startup, exit, model, credential, and transcript behavior otherwise unchanged.
- Make the provider-neutral session engine and both AIO/BoxLite image contracts agree
  with the selected runtime policy.
- Make the security boundary explicit: bypass-mode interactive PTYs are not
  pre-execution approval-gated. The per-task sandbox isolates host/other-task resources,
  while provider-private delivery, exact cleanup, and post-hoc records protect the
  control plane. The same-UID agent can read its owner-scoped CLI credential and current
  provider egress is not an exfiltration boundary; this trusted-owner workload risk is
  documented rather than mislabeled as scoped-credential containment.
- Remove the dead baked Codex hook artifact from the AIO runtime image. The production
  Codex setup already removes `~/.codex/hooks.json`, and the dormant
  `SandboxApprovalEnforcer` is not represented as production coverage.
- This change does not independently redesign the live terminal. At its archive
  boundary it preserves the current inline/replay baseline only as a transitional
  state; `restore-native-live-terminal` owns the subsequent alternate-screen and
  fresh-attachment semantics.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `agent-runtime`: Codex and Claude Code runtime launch policies use their explicit
  bypass modes consistently across interactive/headless entry points.
- `aio-sandbox-execution`: the AIO transport executes the shared runtime launch plan;
  its image contract pins a compatible CLI rather than a dead approval-hook runtime.
- `agent-events-and-approvals`: bypass-mode task PTYs are explicitly outside the
  pre-execution approval gate, and the dormant exec enforcer is described truthfully.

## Impact

- Runtime policy:
  - `apps/api/src/agent-runtime/codex-runtime.ts`
  - `apps/api/src/agent-runtime/claude-code-runtime.ts`
- Provider-neutral terminal mechanism:
  - `packages/sandbox/src/terminal/session-engine.ts`
  - `packages/sandbox/src/terminal/select-launch.ts`
  - `packages/sandbox/src/terminal/session-commands.ts`
- Provider/image contracts:
  - `packages/sandbox-provider-aio`
  - `packages/sandbox-provider-boxlite`
  - `docker/aio-sandbox.Dockerfile`
  - `docker/boxlite-sandbox.Dockerfile`
- Approval truth/documentation:
  - `apps/api/src/sandbox/sandbox-approval-enforcer.ts`
  - `apps/api/src/terminal/terminal.module.ts`
- Tests cover runtime launch strings, resume, provider-neutral startup, both image
  contracts, and real provider canaries.
- No database migration and no public API contract change.
