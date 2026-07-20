# Verification Evidence

## Released candidate

- Environment: `vibe-zlyan`
- Version: `v0.41.3`
- Git SHA: `744a1c42d1ac57ee4452ff06ad4746726c5b3c1d`
- Build time: `2026-07-19T18:18:43Z`

## 6.1 Normal provisioning canary

- Baseline failed task: `573f01af-e52b-4ddc-960c-4d18ba671994`.
- Matching released-candidate task: `70e19dc0-91e7-4ed2-90e9-ea3fdc3f9d14`.
- Repository, owner, branch, runtime/model, sandbox environment, prompt length/hash,
  strategy, skills, delivery mode, and execution mode were compared and matched.
- Attempt 1 settled `succeeded` at stage `agent_launch`, with primary outcome
  `succeeded`, cleanup `not_required`, and 49 durable diagnostic events.
- Runtime preflight, native command start/attach/poll settlement, repository transfer,
  clone, checkout, submodules, runtime setup, and agent launch all succeeded.
- Native attach exited with code 0; diagnostics contained neither a degraded attach
  followed by fabricated empty metadata nor an incomplete-output success.

## 6.2 Provisioning cancellation canary

- Matching canary task: `8b0f92f4-49a5-4473-ab10-5520959ba60e`.
- Provisioning started at `2026-07-19T20:46:12.487Z`; cancellation was issued only
  after `repository_transfer` had started and physical sandbox identity had been
  observed.
- The first and repeated stop requests both returned HTTP 200 with task status
  `cancelled`; no competing failed terminal state appeared.
- Attempt 1 settled `cancelled` at stage `workspace_transfer`, primary cause
  `cancelled`, cleanup `succeeded`, one cleanup attempt, and 31 durable events.
- The SandboxRun settled `removed`; cleanup outcome was `succeeded` with
  provider-backed `already-absent` proof. A direct lookup of the exact BoxLite
  resource returned HTTP 404.
- Audit contained exactly one each of `task.created`, `task.running`, and
  `task.cancelled`, and none of `task.force_failed`, `task.failed`, or
  `agent_failed_to_start`.
- Structured task logs contained no `provision_failed`, `force_failed`, or
  `agent_failed_to_start` event.
- Active capacity moved from 1 to 2 during provisioning and back to 1 after stop;
  the canary disappeared from the active slot set and the idempotent second stop
  did not release capacity again.
- There was no active diagnostic attempt after convergence.

The canary also produced 11 bounded `diagnostic_write_failed` warnings while
multiple diagnostic projections contended. The durable projection therefore
honestly remained `coverage = partial` and had no fabricated completeness marker.
This did not hide the terminal primary or cleanup facts above, and is retained as
an explicit observability limitation rather than being rewritten as complete.

## 6.3 Final gates

- Tasks `6.1`, `6.2`, and `6.3` each passed their declared verifier through
  `node scripts/openspec-metadata.mjs run-task`.
- Strict change validation passed.
- `validate-change` passed for propose, apply, and verify phases.
- The allowlisted `api-mcp` verifier passed.
- `pnpm test:public-surface` passed.
- Public inventory remained 19 Public V1 operations and 18 MCP tools. The only
  REST-only operation remains `tasks.events`; all other Public V1 operations have
  a verified one-to-one MCP mapping.
- `surface-impact.json` remains internal-only, with unchanged runtime wire
  behavior and no Public V1, MCP, OpenAPI, or playground contract delta.
- The clean-clone `public-surface-full` gate and `git diff --check` passed.

The full public-surface gate on the current working tree is intentionally not
used as target-change evidence because an unrelated, user-owned untracked change
directory (`split-guardrails-orchestrator`) is incomplete. The same gate passed
from a clean clone at the target HEAD; that unrelated directory was not modified.
