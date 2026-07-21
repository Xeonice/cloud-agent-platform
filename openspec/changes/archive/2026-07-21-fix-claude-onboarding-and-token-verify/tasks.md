<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: claude-preseed (depends: none)

- [x] 1.1 Add `CLAUDE_CONFIG_DIR_JSON_PATH` constant (`/home/gem/.claude/.claude.json`) to `ClaudeCodeRuntime` and extend the `credential_setup` command in `sandboxSetupCommands` to write the identical pre-seed bytes (base64 → file, `chmod 600`) to BOTH that path and the existing `CLAUDE_JSON_PATH`, in the same single command
- [x] 1.2 Rewrite the now-inverted `CLAUDE_JSON_PATH` doc comment ("CRITICAL — MUST be the HOME-root") to the dual-path rationale, citing both dated observations (2.1.181 HOME-root vs 2.1.207 config-dir) and the upstream docs position
- [x] 1.3 Update `claude-code-runtime` unit tests to assert the `credential_setup` command writes the pre-seed to both paths with identical content and owner-only modes, and that launch-env/settings/prompt writes are otherwise byte-identical to before

## 2. Track: auth-classifier (depends: none)

- [x] 2.1 Add the inline-line pattern to `classifyClaudeOutputFailure`: a standalone terminal line (extend the visual-prefix stripping to cover the `●` bullet) carrying both `please run /login` and `api error: 401` classifies `runtime_auth_rejected`; the same line shape with an expired-token message classifies `runtime_auth_expired`
- [x] 2.2 Add the wizard-screen pattern: rolling window containing BOTH `Welcome to Claude Code` AND `Select login method` classifies `runtime_auth_rejected`
- [x] 2.3 Add classifier tests: golden fixture of the live-captured 2.1.207 wizard screen and the exact `● Please run /login · API Error: 401 Invalid bearer token` line both classify; single-anchor prose quotes and in-paragraph mentions do NOT classify; all pre-existing pattern tests still pass unchanged

## 3. Track: token-verify-api (depends: none)

- [x] 3.1 Extend the shared contracts claude-credential save response schema with an optional verification marker (`verified` | `indeterminate`) and a descriptive-rejection error shape for the 4xx refusal path
- [x] 3.2 Implement the save-time probe in `SettingsService.saveClaudeCredential`: single attempt against the fixed Anthropic host with mode-appropriate auth (OAuth bearer + oauth beta header for subscription; `x-api-key` for API key), ~10 s timeout, outcome classified as definitive-reject (401/403 authentication_error) / definitive-accept (passes auth, incl. HTTP 400 body complaints) / indeterminate (timeout, DNS/connect failure, 5xx)
- [x] 3.3 Wire outcomes: definitive-reject → refuse the save with the descriptive 4xx, persist nothing, prior credential state untouched; definitive-accept → persist as `connected`; indeterminate → persist as `connected` with the indeterminate marker on the response; assert the secret never appears in logs or responses
- [x] 3.4 Service tests with a faked probe transport covering all three outcomes, the no-retry guarantee, prior-state preservation on rejection, and secret-boundary assertions

## 4. Track: token-verify-web (depends: token-verify-api)

- [x] 4.1 Surface the new save outcomes in the Settings Claude card: a definitive rejection renders the descriptive error (credential stays disconnected); an indeterminate verification renders a "saved but unverified — check egress to api.anthropic.com" warning state
- [x] 4.2 Frontend tests for the three save outcomes against the extended contracts schema
