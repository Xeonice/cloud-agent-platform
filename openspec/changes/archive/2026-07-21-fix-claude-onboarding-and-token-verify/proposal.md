# Proposal: fix-claude-onboarding-and-token-verify

## Why

A `claude-code` task on a current sandbox image (claude-code 2.1.207) blocks forever on
Claude's first-run wizard instead of running the prompt: the onboarding pre-seed is
written to `$HOME/.claude.json`, but 2.1.207 reads its main config from
`$CLAUDE_CONFIG_DIR/.claude.json` (the seed location was calibrated to a 2.1.181
anomaly that upstream has since corrected — verified live on vibe-zlyan task
`2bdfafb3`, both directions). Two amplifier gaps turn this into the worst failure mode:
the output classifier recognizes neither the wizard screen nor 2.1.207's inline
`● Please run /login · API Error: 401 Invalid bearer token` line, so the task hangs
`running` instead of failing; and Settings marks a pasted setup-token `connected`
without ever exercising it, so an invalid token (as in the incident — Anthropic
rejects the stored token with `authentication_error`) is only discovered inside a task.
See `research-brief.md` for the full evidence chain.

## What Changes

- **Dual-path onboarding pre-seed**: `ClaudeCodeRuntime.sandboxSetupCommands` writes the
  identical pre-seed `.claude.json` to BOTH `$CLAUDE_CONFIG_DIR/.claude.json`
  (authoritative for claude ≥ 2.1.207) and `$HOME/.claude.json` (legacy behavior,
  e.g. 2.1.181-era images), so the wizard is suppressed regardless of which side of the
  upstream behavior change the image's claude version falls on. The inverted "CRITICAL —
  MUST be the HOME-root" guidance is corrected.
- **Classifier covers current claude phrasings**: `classifyClaudeOutputFailure` gains
  patterns for (a) the 2.1.207 inline auth-error line
  (`● Please run /login · API Error: 401 …`) → `runtime_auth_rejected`, and (b) the
  first-run wizard screen ("Select login method" / login-method menu) → a fail-closed
  auth/config failure, so a wizard regression or a rejected token terminates the task
  with a `reconnect_runtime` action instead of hanging `running` indefinitely.
- **Connect-time token verification**: saving a Claude credential performs a real
  probe against Anthropic (oauth bearer for subscription mode, `x-api-key` for API-key
  mode). A definitive Anthropic rejection (401-class) refuses to mark the credential
  `connected` and returns a descriptive error; a network-indeterminate result does not
  hard-block the save (self-hosted hosts may have restricted egress) but is surfaced.

## Capabilities

### New Capabilities

_None — all three fixes change requirements of existing capabilities._

### Modified Capabilities

- `agent-runtime`: the "Provision-time trust and onboarding pre-seed" requirement is
  rewritten from HOME-root-only (with its now-inverted rationale) to dual-path seeding
  with config-dir authoritative; a new requirement makes Claude auth-failure output
  classification cover the current CLI's inline error line and the first-run wizard
  screen as fail-closed classifications.
- `account-settings`: the "Claude Code runtime credential" requirement gains
  connect-time verification semantics — a save only reaches `connected` after the
  credential survives a live Anthropic probe (with an explicit
  network-indeterminate carve-out), mirroring the codex "Test/validate a saved
  credential" precedent.

## Impact

- **Code**: `apps/api/src/agent-runtime/claude-code-runtime.ts` (pre-seed commands +
  path constants + doc comments), `apps/api/src/agent-runtime/runtime-output-failure-classifier.ts`
  (+ its spec files), `apps/api/src/settings/settings.service.ts` /
  `settings.controller.ts` (claude save path gains a verification step), contracts if
  the save response gains a verification-result field, and `apps/web` Settings UI copy
  for the new rejection/warning states.
- **Behavior**: no schema/migration impact; no codex-path changes (parity check in the
  research brief found no equivalent defect). Existing valid-token deployments see no
  difference except that tasks now fail fast (instead of hanging) when auth is broken.
- **Operator-visible**: an invalid pasted token is now rejected at Settings save time
  with a clear reason; the stuck-wizard failure mode disappears on current images and
  becomes a classified fast-fail if it ever regresses.
