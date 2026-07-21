# Design: fix-claude-onboarding-and-token-verify

## Context

Live evidence (research-brief.md, vibe-zlyan task `2bdfafb3`, claude-code 2.1.207):

1. `ClaudeCodeRuntime` seeds onboarding state at `$HOME/.claude.json`
   (`CLAUDE_JSON_PATH = /home/gem/.claude.json`), per a 2.1.181 observation the spec
   hard-codes as CRITICAL. 2.1.207 reads `$CLAUDE_CONFIG_DIR/.claude.json` instead
   (matching current official docs), ignores the HOME-root seed, and blocks on the
   first-run wizard. Seeding the config-dir path was experimentally verified to
   suppress the wizard on 2.1.207.
2. `classifyClaudeOutputFailure` misses both the wizard screen and 2.1.207's inline
   `● Please run /login · API Error: 401 Invalid bearer token` line, so the task hangs
   `running` instead of failing with `reconnect_runtime`.
3. `PUT /settings/claude` flips `state=connected` without exercising the token; the
   incident token is rejected by Anthropic (`authentication_error`, verified with a
   direct in-sandbox curl using the oauth bearer + `anthropic-beta: oauth-2025-04-20`).

Constraints: sandbox images pin different claude versions across deployments (the
platform does not control which side of the upstream behavior change an image is on);
self-hosted API hosts may have restricted egress to `api.anthropic.com`; secrets must
never appear in logs, status paths, or launch argv (existing SECRET BOUNDARY rules).

## Goals / Non-Goals

**Goals:**

- Interactive `claude-code` tasks never block on the first-run wizard, on any claude
  version an image may pin (both sides of the `CLAUDE_CONFIG_DIR` behavior change).
- A rejected/expired token or a wizard regression terminates the task as a classified
  auth failure (`reconnect_runtime` action), never an indefinite `running` hang.
- An invalid setup-token or API key is caught when the operator saves it in Settings,
  with a descriptive rejection, before any task depends on it.

**Non-Goals:**

- No codex-path changes (parity check found no equivalent defect).
- No new task failure codes / contracts enum values — the two existing
  `runtime_auth_*` codes and their `reconnect_runtime` action are sufficient.
- No periodic re-verification of stored credentials (tokens can expire later; that
  remains detected at task time by the classifier, now reliably).
- No handling of the wizard as an interactive flow (no keystroke automation).

## Decisions

### D1 — Seed the pre-seed `.claude.json` to BOTH paths

`sandboxSetupCommands` writes the identical pre-seed bytes to
`$CLAUDE_CONFIG_DIR/.claude.json` (`/home/gem/.claude/.claude.json`) AND the existing
`$HOME/.claude.json`, in the same single `credential_setup` command (one more
`printf | base64 -d > file && chmod 600` clause; the config dir is already `mkdir -p`'d
first).

- *Why both, not config-dir only:* the platform cannot assume an image's claude
  version. ≥2.1.207 reads the config-dir copy; 2.1.181-era reads the HOME root. Both
  writes are 239 bytes, idempotent, and mutually invisible — whichever copy claude
  ignores is inert. This removes the version cliff instead of relocating it.
- *Why not detect the claude version and pick one path:* a version probe adds a
  provision-time exec + a parsing seam that itself drifts; two static writes are
  strictly simpler and cover unknown future versions that keep either behavior.
- `CLAUDE_JSON_PATH` stays (HOME-root), a new `CLAUDE_CONFIG_DIR_JSON_PATH` constant is
  added, and the now-inverted "CRITICAL — MUST be the HOME-root" doc comment is
  rewritten to describe the dual-path rationale with both observations dated.

### D2 — Classifier: two new fail-closed patterns, kept narrow

In `classifyClaudeOutputFailure`:

1. **Inline auth-error line** (2.1.207 TUI shape): a single terminal line containing
   both `please run /login` and `api error: 401` (order-independent, whitespace
   collapsed, `●`/bullet prefixes stripped by the existing standalone-line matcher)
   → `runtime_auth_rejected`. An `oauth token has expired` variant on the same shape
   → `runtime_auth_expired`. The existing JSON-envelope and standalone-line patterns
   remain untouched.
2. **First-run wizard screen**: the rolling window containing BOTH
   `Welcome to Claude Code` AND `Select login method` (two distinct stable lines of
   the wizard) → `runtime_auth_rejected`. Requiring both strings avoids false
   positives from prose or transcripts quoting one of them.

- *Why map the wizard to `runtime_auth_rejected` rather than a new code:* after D1 the
  wizard can only appear when onboarding suppression failed (a platform/image
  regression) — the honest operator remedy is still "reconnect / investigate runtime",
  and `reconnect_runtime` surfaces a visible failed task instead of a silent hang. A
  new enum value would ripple through contracts, web copy, and the public v1 API for a
  state that should never occur post-fix.
- *Why not match on the box-drawing "Select login method" menu items:* menu item text
  (subscription/console/3rd-party wording) is marketing copy that churns; the two
  chosen anchors have been stable across 2.0–2.1.

### D3 — Connect-time verification: probe Anthropic, reject on definitive 401-class only

`SettingsService.saveClaudeCredential` gains a verification step before persisting:

- **Subscription mode:** `POST https://api.anthropic.com/v1/messages` with
  `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20` +
  `anthropic-version`, and a deliberately minimal/invalid body. Anthropic checks auth
  before body validation: `401/403` ⇒ credential rejected; `400` (body complaint) or
  `2xx` ⇒ credential accepted — a zero-cost probe (no tokens consumed on the 400
  path). This exact 401 shape is the one captured live in the incident.
- **API-key mode:** same call with `x-api-key: <key>` (standard header scheme).
- **Outcome handling:**
  - Definitive rejection (401/403 `authentication_error`) → the save is refused with a
    descriptive 4xx (message distinguishes "Anthropic rejected this token"), nothing is
    persisted, prior credential state is untouched.
  - Definitive acceptance (400/2xx) → persist as today, `state=connected`.
  - Indeterminate (timeout ~10 s, DNS/connect failure, 5xx) → persist and mark
    `connected`, but the response carries a `verification: 'indeterminate'` marker the
    UI surfaces as a warning — self-hosted hosts with restricted egress must not be
    bricked out of saving a credential.
- *Why verify-on-save rather than a separate "test" button like codex:* the codex
  test-credential requirement exists because codex has multiple provider modes with
  operator-supplied base URLs; the Claude probe has a fixed, known-good endpoint, so
  folding it into the save removes the failure mode entirely (an unexercised
  credential can't reach `connected`) at the cost of one extra HTTP round-trip on save.
  The response shape extension (verification result) lives in the shared contracts
  schema so web and API stay in lockstep.
- The probe never logs the token, mirrors `assertSafeProviderUrl` discipline (fixed
  host, so no SSRF surface), and runs with a single attempt (no retry storm on save).

## Risks / Trade-offs

- [Upstream flips config location again / removes `CLAUDE_CODE_OAUTH_TOKEN` env
  support] → dual-path seeding covers relocation between the two known paths; the
  classifier (D2) converts any residual wizard into a fast classified failure instead
  of a hang, which is the containment layer for unknown future drift.
- [Wizard strings change in a future claude major] → D2's anchors are the most stable
  strings observed across 2.0–2.1; if they churn, behavior degrades to today's (hang),
  never to a false positive. Golden fixtures pin the exact observed 2.1.207 screen.
- [False-positive classification on prose quoting the error line] → both new patterns
  require the standalone-line / dual-anchor context, mirroring the existing
  `hasStandaloneTerminalLine` discipline that already guards codex patterns.
- [Anthropic 5xx or egress-blocked host at save time] → indeterminate carve-out saves
  with a warning; the task-time classifier remains the backstop, so the incident's
  silent-hang mode cannot recur even for unverified credentials.
- [Probe endpoint semantics change (auth no longer checked before body validation)] →
  then valid tokens would 400→accepted (unchanged) and invalid ones might 400 instead
  of 401 → worst case is accepting a bad token, degrading to the classifier backstop —
  never rejecting a good one.

## Migration Plan

Pure application change (api + web + contracts): ships in the normal release train; no
schema migration, no data backfill. Existing stored credentials are untouched (they are
re-verified only when re-saved). Rollback = revert the release. The stuck incident task
on vibe-zlyan is cancelled manually by the operator; the invalid stored token is
re-minted (`claude setup-token`) and re-pasted, at which point the new save-time probe
confirms it.

## Open Questions

- None blocking. (Whether to ALSO backfill-verify existing stored claude credentials at
  boot was considered and rejected — it would flip working deployments' state on
  transient egress failures; task-time classification is the agreed backstop.)
