<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: shared-contracts (depends: none)

- [x] 1.1 Replace the synchronous Codex device-login start/status schemas in packages/contracts/src/settings.ts with a sessionId-bearing start response and a discriminated status union for preparing, awaiting_authorization, finalizing, connected, cancelled, expired, and error; remove the misleading OpenAI expiresInSeconds field and carry the CAP expiresAt deadline.
- [x] 1.2 Add/extend compiled contract tests for every status variant, required awaiting-only URL/code fields, rejection of secret-bearing terminal payloads, and session-id path validation, then run the contracts typecheck/lint/build.

## 2. Track: app-server-runner (depends: shared-contracts)

- [x] 2.1 Add a CodexDeviceLoginRunner port and injectable Docker implementation boundary under apps/api/src/settings, with typed start/completion/cancel/readCredential/dispose operations and stable secret-free error categories.
- [x] 2.2 Implement the size-bounded App Server JSONL client: initialize response followed by initialized, request-id correlation, chatgptDeviceCode start, matching account/login/completed notification, account/login/cancel, AbortSignal timeouts, unknown-notification tolerance, and malformed/oversized response rejection.
- [x] 2.3 Implement the Docker runner using argv-based non-TTY dockerode exec with attached/hijacked stdin/stdout/stderr, numeric gem user, HOME/CODEX_HOME/working directory, file credential-store configuration, Docker modem stdout/stderr demultiplexing, incremental StringDecoder JSONL parsing, and bounded redacted stderr.
- [x] 2.4 Inspect the configured pinned AIO image before create, apply stable login-worker ownership/session labels, perform only a bounded Codex/home preflight, read auth.json through a second bounded direct exec, and make cancellation/disposal idempotently stop streams, exec work, and the container without using AIO /v1/docs or /v1/shell/exec.
- [x] 2.5 Add collected runner/protocol .spec.ts tests with fake fragmented/coalesced Docker frames covering handshake order, device-code result, matching/mismatched completion, cancellation, unknown notifications, malformed/oversized JSON, stderr separation, process exit, timeout/abort, image-unavailable classification, credential size limits, and repeated disposal.
- [x] 2.6 Add a pinned-Codex compatibility check based on codex app-server generate-json-schema (or a checked minimal fixture derived from it) so a Codex image version bump fails when the consumed login types or notifications disappear, without performing a real OpenAI login in CI.

## 3. Track: device-login-service-api (depends: shared-contracts, app-server-runner)

- [x] 3.1 Refactor CodexDeviceLoginService around sessionsById and activeSessionByAccount, inserting the opaque session and CAP deadline before any await, returning the same active session for repeated starts, retaining secret-free terminal records briefly, and removing lastPolledAt/ABANDONED_AFTER_MS behavior.
- [x] 3.2 Start the runner as guarded background work and implement explicit allowed state transitions whose sessionId/generation compare-and-set prevents cancelled, expired, terminal, or superseded attempts from publishing codes, saving credentials, or deleting a newer session.
- [x] 3.3 Implement cancel-first cleanup for preparing and awaiting sessions, hard CAP deadline expiry, runner/App Server cancellation, idempotent terminal cleanup, OnModuleDestroy disposal, and OnModuleInit cleanup of stale labelled login containers from a prior crashed single-API process.
- [x] 3.4 On a matching successful completion, transition to finalizing, read and strictly validate file-backed ChatGPT auth JSON (reject auth_mode-only, tokens:null, missing-token, and empty-access-token scaffolds), persist through SettingsService only after validation, publish connected only after save succeeds, and preserve the prior credential on every failure.
- [x] 3.5 Wire the runner provider in settings.module.ts and change settings.controller.ts to POST 202 plus sessionId-scoped GET/DELETE routes, account-isolated 404 behavior, idempotent DELETE, and Cache-Control: no-store on success and error responses.
- [x] 3.6 Add collected service/controller .spec.ts coverage for local and GitHub account scoping, identity-less rejection, idempotent double start, cancel during prepare, cancel-vs-completion, stale completion after retry, old cleanup not deleting a new worker, non-overlapping finalization, persistence failure, TTL, shutdown/startup orphan cleanup, cross-account non-enumeration, HTTP 202, path scoping, and no-store headers.
- [x] 3.7 Remove the uncollected codex-device-login.test.mjs parser test and delete parseDeviceCode, detached log polling, AIO HTTP readiness/shell helpers, hard-coded OpenAI expiry, and any raw protocol/auth diagnostic logging made obsolete by the runner.

## 4. Track: clipboard-helper (depends: none)

- [x] 4.1 Add an apps/web shared copyText helper with a typed result that prefers secure-context navigator.clipboard.writeText, uses a temporary offscreen readonly textarea compatibility path when unavailable/rejected, restores focus/selection, and never reports success without a positive browser result.
- [x] 4.2 Add Vitest coverage for secure clipboard success, missing navigator.clipboard on non-secure origins, NotAllowedError fallback, compatibility success/failure, temporary-node cleanup, focus restoration, and a fully failed result suitable for manual-copy recovery.

## 5. Track: direct-login-web (depends: shared-contracts, clipboard-helper)

- [x] 5.1 Update apps/web/src/lib/api/real.ts to consume the shared asynchronous start contract and sessionId-scoped GET/DELETE routes, preserving schema validation and propagating secret-free API errors.
- [x] 5.2 Refactor codex-direct-dialog.tsx to render the server state machine, store sessionId plus a local generation/AbortController, use serialized non-overlapping polling, cancel the exact attempt on close/retry/unmount, and ignore all late promises after dismissal or supersession.
- [x] 5.3 Remove every about:blank/window-handle path and render the returned URL/code only in awaiting_authorization, with a fresh user-activated target=_blank link carrying noopener, noreferrer, and no-referrer policy; preserve the compact dialog shell and existing connected-status query refresh.
- [x] 5.4 Integrate the shared copy helper, disable copy before code issuance, show copied feedback only on success, and on total failure focus/select the visible code with localized Ctrl+C/Command+C guidance instead of silently swallowing the error.
- [x] 5.5 Add component/Vitest coverage for preparing, awaiting, finalizing, connected, cancelled, expired, and error states; active-session retry; close-during-start; stale response rejection; serialized polling; no about:blank/window.open; exact safe-link attributes; and modern/compatibility/manual copy outcomes.

## 6. Track: operator-docs (depends: device-login-service-api)

- [x] 6.1 Update self-host/troubleshooting documentation to describe the two-stage official Codex flow, the CAP-local session deadline, HTTPS recommendation plus HTTP copy fallback, and the retained requirement that the pinned AIO login image be present even when BoxLite is the task provider.
- [x] 6.2 Document the stable missing-login-image diagnostic and remediation without implying that CAP directly implements OpenAI OAuth or that BoxLite task-provider selection supplies a BoxLite login runner.

## 7. Track: integration-verification (depends: device-login-service-api, direct-login-web, operator-docs)

- [x] 7.1 Run pnpm --filter @cap/api test, pnpm --filter @cap/web test, contracts/API/Web typechecks and lints, and the affected builds; fix every failure in the changed code and confirm the new .spec.ts files are actually collected.
- [x] 7.2 Run a Docker-backed smoke against the pinned AIO image that starts App Server over direct stdio exec, completes initialize plus device-code start far enough to receive the structured response, exercises cancellation/cleanup without authorizing a real account, and proves the path does not wait for AIO HTTP readiness.
- [x] 7.3 Use Playwright to verify the real dialog on localhost and a non-loopback HTTP origin: no blank tab during preparation, explicit opener-safe authorization action after code issuance, working clipboard fallback/manual guidance, cancel during preparation, and no stale UI resurrection.
- [x] 7.4 Reconcile any intentionally changed settings/dialog visual fixture with redesign-settings-single-column, run the affected visual check where a fixture exists, and confirm the compact fixed-width/height-capped shell did not regress.
- [x] 7.5 Run negative source checks proving about:blank, codex login --device-auth log parsing, /tmp/codexlogin.log, AIO /v1/docs readiness, and the old account-implicit device-login calls are gone from the production path; run openspec validate harden-codex-device-login --strict and record the final verification results.
