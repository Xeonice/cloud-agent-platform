# Research Brief — fix-claude-onboarding-and-token-verify

Evidence gathered 2026-07-21 by live investigation of a stuck production task on the
vibe-zlyan self-hosted stack (v0.43.0, BoxLite provider, sandbox image with
claude-code 2.1.207). All findings below are first-hand observations, not inference.

## Incident

Task `2bdfafb3-96a1-4f49-ab72-dbc33b60d658` (runtime `claude-code`, interactive-pty)
launched and then sat in `running` forever showing Claude Code's first-run wizard
("Select login method") in the task terminal. The operator had just connected a
`claude setup-token` in Settings (row: `mode=subscription`, `state=connected`,
ciphertext present, owner matches).

## Finding 1 — onboarding pre-seed is written to a path claude 2.1.207 no longer reads

Provisioning worked exactly as specified: `launch-env.sh` (279 B, valid export),
`settings.json`, prompt file, and the onboarding pre-seed all landed in the sandbox,
and `claude` was launched with `CLAUDE_CODE_OAUTH_TOKEN` present in its process env
(verified via `/proc/<pid>/environ`).

But two `.claude.json` files existed after launch:

| Path | Size / mtime | Content |
|---|---|---|
| `/home/gem/.claude.json` (HOME root — where we seed) | 239 B, 02:30:20 | full pre-seed, `hasCompletedOnboarding:true` |
| `/home/gem/.claude/.claude.json` (`$CLAUDE_CONFIG_DIR` — where claude reads) | 28 898 B, 02:30:23 (3 s after launch) | claude-created, fresh, NO onboarding keys |

claude 2.1.207 reads/writes its main config at `$CLAUDE_CONFIG_DIR/.claude.json` when
`CLAUDE_CONFIG_DIR` is set. The HOME-root file is ignored entirely. It therefore treats
the sandbox as a fresh install and blocks on the full onboarding wizard (including the
login-method screen) even though a token is present in the environment.

**Controlled experiment (same sandbox, same image):** seeding the identical pre-seed
JSON into a fresh `CLAUDE_CONFIG_DIR`'s `.claude.json` made 2.1.207 skip the wizard
entirely and auto-run the positional prompt. Both directions verified.

**History:** archived change `2026-06-20-fix-claude-onboarding-seed-path` moved the
seed TO the HOME root, based on a live-sandbox observation on claude 2.1.181 that the
config-dir copy was ignored. The current spec requirement ("Provision-time trust and
onboarding pre-seed") hard-codes that observation, including a CRITICAL note that is
now inverted. Official docs today
([code.claude.com/docs/en/claude-directory](https://code.claude.com/docs/en/claude-directory))
state "If you set `CLAUDE_CONFIG_DIR`, every `~/.claude` path on this page lives under
that directory instead" — and the page's file tree includes `~/.claude.json`. Community
issues ([#14313](https://github.com/anthropics/claude-code/issues/14313),
[#25998](https://github.com/anthropics/claude-code/issues/25998),
[#24479](https://github.com/anthropics/claude-code/issues/24479)) treat home-root
placement in config-dir setups as the bug. Conclusion: 2.1.181's behavior was the
anomaly; 2.1.207 is the intended behavior. Pinning to either single path is fragile —
the robust fix is to seed BOTH paths.

## Finding 2 — the operator's stored setup-token is invalid, and nothing catches it

With the wizard bypassed (experiment above), claude immediately failed with the inline
TUI line:

```
● Please run /login · API Error: 401 Invalid bearer token
```

A direct `curl` from inside the sandbox to `https://api.anthropic.com/v1/messages`
with `Authorization: Bearer <stored token>` + `anthropic-beta: oauth-2025-04-20`
returned `{"type":"error","error":{"type":"authentication_error","message":"Invalid
bearer token"}}` — the token as pasted is rejected by Anthropic itself (AES-GCM is
authenticated encryption; silent decrypt corruption is impossible, so the stored
plaintext is exactly what the operator pasted).

Two systemic gaps follow:

1. **Classifier gap.** `classifyClaudeOutputFailure` recognizes neither the first-run
   wizard screen nor the 2.1.207 inline error shape. Its patterns require standalone
   lines like `Invalid API key · Please run /login` or a JSON
   `authentication_error` envelope adjacent to `API Error: 401`. The observed line
   `● Please run /login · API Error: 401 Invalid bearer token` matches nothing, so the
   task never fails — it hangs `running` until an operator intervenes.
2. **Connect-time gap.** `PUT /settings/claude` stores the token and flips
   `state=connected` without ever exercising it. Codex has a "测试凭据" requirement
   (account-settings spec, "Test/validate a saved Codex credential"); Claude has no
   analog, so a bad paste is only discovered minutes later inside a task — as an
   un-classified hang, per gap 1.

## Codex parity check (no equivalent defect)

- Codex config is written to codex's DEFAULT dir (`/home/gem/.codex`); no `CODEX_HOME`
  relocation env is set, so there is no "seed path A, read path B" surface.
- Codex has no interactive onboarding wizard; trust is a pure `config.toml` read.
- Empirical: codex 0.144.1 on the same image completes headless and interactive tasks
  (prod 2026-07-12…14).

## Constraints for design

- The pre-seed and launch line live in `ClaudeCodeRuntime` (`apps/api/src/agent-runtime/claude-code-runtime.ts`);
  `CLAUDE_JSON_PATH` is currently the HOME-root constant and its doc comment asserts the
  now-inverted 2.1.181 behavior.
- Classifier lives in `apps/api/src/agent-runtime/runtime-output-failure-classifier.ts`
  (`classifyClaudeOutputFailure`), consumed via `AgentRuntime.classifyOutputFailure`
  from the rolling terminal output window; failure codes `runtime_auth_expired` /
  `runtime_auth_rejected` map to operator action `reconnect_runtime`.
- The wizard screen contains stable strings ("Welcome to Claude Code",
  "Select login method", the numbered login options) — but wizard presence means
  onboarding was NOT suppressed, which after the pre-seed fix should be impossible;
  classify it as an auth/config failure so regressions fail fast instead of hanging.
- Settings save path: `SettingsController.saveClaude` → `SettingsService.saveClaudeCredential`;
  codex compatible-provider validation & SSRF guard (`assertSafeProviderUrl`) show the
  existing pattern for outbound verification from the API host. Claude verification
  must call Anthropic (`api.anthropic.com`) with the oauth bearer + `anthropic-beta:
  oauth-2025-04-20` header; a cheap authenticated endpoint suffices (the 401 vs 200
  distinction is the signal). API-key mode should use the standard `x-api-key` header
  scheme instead.
- Self-hosted API hosts may have restricted egress; verification failure modes must
  distinguish "Anthropic said 401" (reject) from "network unreachable" (do not
  hard-block the save — surface a warning) to avoid bricking air-gapped setups.
