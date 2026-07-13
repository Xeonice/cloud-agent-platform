## Context

The official-account path in the settings dialog currently combines browser popup handling, temporary sandbox provisioning, CLI process management, OAuth progress, credential harvesting, and UI polling into one synchronous start call. The Web client opens about:blank during the initial click so it can retain a popup handle, while CodexDeviceLoginService waits for an AIO HTTP readiness probe, launches codex login --device-auth through the AIO shell endpoint, and parses ANSI log text for a URL and code. Only then does the service add an entry to its account-keyed session map.

That ordering creates both visible latency and lifecycle gaps: a start cannot be cancelled before the code exists, a stale worker can finish after the dialog has closed or retried, and the public contract cannot represent preparation. The copy button has a separate platform mismatch: CAP supports plain HTTP access by a non-loopback self-host IP, while navigator.clipboard is a secure-context API.

Codex 0.144.1, already pinned in the CAP AIO image, exposes account/login/start with type chatgptDeviceCode through Codex App Server. It returns a structured loginId, verificationUrl, and userCode, publishes account/login/completed, and accepts account/login/cancel. App Server's default stdio transport is JSONL; its WebSocket transport is explicitly experimental and unsupported. Codex remains the OAuth client and owns OpenAI token polling.

Existing boundaries that must remain intact:

- Device login and stored credentials are scoped by the authenticated account id, including local accounts without a GitHub identity.
- SettingsService is the encryption and persistence boundary for official Codex credentials.
- Task execution continues to use the existing interactive PTY/runtime path. App Server is only a temporary authentication control-plane process.
- The active redesign-settings-single-column change owns settings page/card/dialog composition and explicitly leaves the direct-login state machine unchanged. This change preserves that shell and changes only the dialog's internal behavior.
- No persistent login-session model exists today, and a device login is disposable setup work rather than a durable task.
- The current BoxLite quick-deploy path does not stage the AIO image, although the existing device-login service still requires AIO_SANDBOX_IMAGE through local Docker. The first runner retains this limitation and must fail immediately and clearly when the pinned image is unavailable.

## Goals / Non-Goals

**Goals:**

- Return control to the browser immediately with a queryable preparing session.
- Consume Codex's structured device-login protocol rather than human-facing CLI output.
- Make preparation and authorization cancellable, idempotent, account-isolated, and safe against late async results.
- Remove the blank popup while retaining a reliable, opener-safe path to OpenAI authorization.
- Make device-code copy usable and observable on secure origins and supported self-host HTTP origins.
- Preserve encrypted credential storage, temporary-worker cleanup, and the existing task runtime architecture.
- Add enough protocol and lifecycle coverage that a pinned Codex upgrade fails compatibility checks before release.

**Non-Goals:**

- Implement OpenAI OAuth device endpoints, token polling, interval, or slow_down logic in CAP.
- Replace the task sandbox provider abstraction or move task execution to Codex App Server.
- Build a dedicated authentication image or a BoxLite login-worker implementation in this change.
- Persist in-flight device-login sessions across API restarts.
- Require HTTPS for all self-host installations as part of this fix.
- Redesign the settings page, Codex credential card, or compact dialog shell.
- Migrate every existing copy button in apps/web; the helper is reusable, but this change must migrate and verify the device-code action.

## Decisions

### D1 — Introduce a session-scoped asynchronous REST contract

POST /settings/codex/device-login returns HTTP 202 as soon as an in-memory session record has been created:

    {
      "sessionId": "<opaque uuid>",
      "status": "preparing",
      "expiresAt": "<CAP session deadline>"
    }

GET /settings/codex/device-login/:sessionId returns a discriminated status union. Only awaiting_authorization carries verificationUri and userCode. DELETE /settings/codex/device-login/:sessionId is idempotent and returns 204 for an already terminal or unknown attempt, avoiding session enumeration.

The shared Zod contract lives in packages/contracts. It includes sessionId on every variant and uses these states:

| State | Meaning | Worker resources |
| --- | --- | --- |
| preparing | Container/App Server is starting and no code is available | retained |
| awaiting_authorization | Structured URL/code received; Codex is polling OpenAI | retained |
| finalizing | Codex reported success; CAP is validating and saving the credential | retained |
| connected | Credential was encrypted and persisted | reclaimed |
| cancelled | Operator cancelled the attempt | reclaimed |
| expired | CAP's local session deadline passed | reclaimed |
| error | Preparation, protocol, or persistence failed | reclaimed |

The response uses expiresAt as a CAP resource/session deadline, not expiresInSeconds presented as an OpenAI guarantee. POST, GET, DELETE, and all device-login error responses set Cache-Control: no-store.

An account may have one nonterminal session. A repeated POST returns the same active session, which makes browser/network retries idempotent and prevents duplicate workers. A new attempt is created only after the previous attempt is terminal; the UI can explicitly cancel first when the operator requests a fresh retry.

Alternative considered: keep account-implicit GET/DELETE. Rejected because a delayed response or close action cannot be tied to the attempt that produced it.

Alternative considered: persist sessions in the database. Rejected because an API restart cannot safely reattach to the stdio App Server process with the current container ownership model; restart cleanup plus a visible retry is simpler and honest.

### D2 — Separate lifecycle orchestration from the Docker/App Server adapter

CodexDeviceLoginService owns account/session policy and SettingsService integration. A narrow CodexDeviceLoginRunner boundary owns temporary process mechanics:

- create/start the worker;
- initialize Codex App Server over a duplex JSONL transport;
- start chatgptDeviceCode login and surface structured events;
- request cancellation when loginId exists;
- read the resulting file-backed credential;
- close streams and remove temporary resources idempotently.

The first implementation, DockerCodexDeviceLoginRunner, reuses AIO_SANDBOX_IMAGE because it already contains the pinned Codex binary. It creates one temporary container and one App Server process per CAP login session. It does not reuse SandboxProviderPort: that port is task/workspace-oriented and carries task ownership, deliverables, and provider lifecycle semantics that do not apply to an ephemeral authentication worker.

This boundary leaves room for a smaller image or provider-specific implementation later without putting Docker calls back into the session service.

Before container creation, the runner inspects the configured pinned image and maps an unavailable image to a stable device_login_worker_image_unavailable category with actionable, secret-free operator copy. It does not silently pull an unpinned tag. This makes the retained BoxLite/AIO dependency visible without expanding this change into provider parity.

### D3 — Run App Server through an attached, non-TTY Docker exec

After container.start(), the runner creates a Docker exec with stdin/stdout/stderr attached, Tty=false, the numeric unprivileged user, HOME=/home/gem, and CODEX_HOME=/home/gem/.codex. It launches the pinned codex app-server using the default/explicit stdio listener and a config override selecting cli_auth_credentials_store=file.

The runner performs a small bounded preflight for the Codex binary and writable CODEX_HOME if the image's runtime user/home is not immediately ready. It does not wait for the AIO HTTP /v1/docs endpoint and does not call /v1/shell/exec. Docker's multiplexed stdout/stderr frames are demultiplexed; only stdout is fed to an incremental, size-bounded JSONL decoder. Stderr is reduced to redacted diagnostics and never mixed into the protocol stream.

The protocol adapter:

1. sends initialize and then initialized;
2. sends account/login/start with type chatgptDeviceCode;
3. correlates JSON responses by request id;
4. publishes account/login/completed to the session service;
5. sends account/login/cancel when requested and loginId is known;
6. rejects malformed known responses, process exit, or stage timeouts;
7. ignores unknown notifications for forward compatibility.

Every pending request and stage has an AbortSignal-backed timeout. Input buffers and auth.json reads have explicit size limits.

Alternative considered: App Server WebSocket transport. Rejected because Codex documents it as experimental and unsupported and it adds a listener/authentication surface that is unnecessary inside the owned container.

Alternative considered: continue codex login --device-auth and improve the regex. Rejected because there is no JSON mode and ANSI, wording, URL, and code-format changes remain an integration dependency.

### D4 — Record the attempt before launching work and guard every transition

The service keeps:

- sessionsById: sessionId to a serializable state record plus optional live runner handle;
- activeSessionByAccount: account id to the current nonterminal sessionId;
- one AbortController and one local deadline timer per live attempt.

The record is inserted before any asynchronous create/start call. Background preparation receives sessionId and an attempt generation token. A single transition helper checks account ownership, current generation, allowed source state, and nonterminal status before mutating the record. A transition that loses this compare-and-set check performs cleanup only and cannot publish data or save credentials.

Cancellation first commits cancelled and clears activeSessionByAccount, then aborts preparation, requests App Server cancellation when possible, and disposes the runner. This ordering makes cancellation authoritative even if Docker or protocol cleanup is slow.

Login containers receive stable component/session ownership labels. Terminal records retain only sessionId, state, timestamps, and a secret-free message for a short bounded observation window; all worker handles, user codes, URLs, and credentials are cleared on terminal transition. The sweeper uses the absolute CAP deadline and terminal-retention deadline, not time since the last browser poll. Module destruction aborts and disposes every live runner, and module initialization removes stale labelled login containers left by a prior crashed single-API process. This startup cleanup relies on CAP's current single local API owner for the Docker daemon; multi-replica ownership is out of scope.

Alternative considered: use lastPolledAt as liveness. Rejected because background-tab throttling or a transient network gap can incorrectly destroy a login that is still within the advertised window.

### D5 — Finalize through the existing encrypted credential boundary

On account/login/completed success, the guarded state moves to finalizing. The runner reads /home/gem/.codex/auth.json into a size-bounded in-memory buffer. A tightened validator requires a JSON object with the expected ChatGPT token object and a non-empty access token; auth_mode alone, tokens:null, and tokenless scaffolds are rejected. Whether a refresh token is mandatory is based on the pinned 0.144.1 file schema and is covered by fixtures. Only after strict validation does CodexDeviceLoginService call SettingsService.saveCredential(operator, { mode: "official", authJson }).

Connected is published only after persistence succeeds. Validation or persistence failure moves the attempt to error and leaves the previous stored credential untouched. Cleanup runs in a finally path and zeroes/drops in-memory references as far as JavaScript permits.

No user code, auth JSON, access token, refresh token, or unredacted protocol payload is logged. Observability records sessionId, container name, phase, duration, and a stable internal error category only. Client messages are mapped from categories rather than raw stderr or exception bodies.

Alternative considered: let Codex choose auto/keyring storage. Rejected because a headless temporary worker must produce a harvestable file deterministically; the task runtime already applies the same file-store rule.

### D6 — Use a two-stage in-dialog authorization UX

The dialog's client state is driven by the server discriminated union and stores the current sessionId in both state and a generation ref:

1. Connect calls POST and renders preparing inside the existing dialog.
2. Serialized polling GET uses that sessionId and never opens a browser window; a recursive timeout/query refetch cannot overlap requests the way setInterval(async) can.
3. awaiting_authorization renders the exact server-provided URL and user code.
4. A normal anchor/button activated by a fresh user click opens the URL in a new tab with target="_blank", rel="noopener noreferrer", and referrerPolicy="no-referrer".
5. finalizing renders a short persistence state; connected refreshes the existing settings query/status surfaces.
6. Close/cancel stops local polling, invalidates the local generation, and best-effort DELETEs the exact session. Any late promise first checks the generation before changing UI.

The link is never hard-coded and CAP does not append the user code. The direct dialog continues to use the compact, height-capped shell owned by the settings redesign.

Alternative considered: a same-origin waiting tab that redirects itself. It would preserve one-click navigation without a blank page, but introduces a second route, cross-tab coordination, and another cancel surface. The explicit second user action is simpler, standards-aligned, and easier to understand.

### D7 — Add a shared copy helper with an honest fallback

apps/web receives a small copyText utility returning a discriminated result such as success with method clipboard/compatibility or failure with a reason. The device-code handler uses it directly from the click event.

- When window.isSecureContext and navigator.clipboard.writeText exist, use the asynchronous Clipboard API.
- When the modern API is absent or rejects, best-effort a compatibility path using a temporarily attached offscreen readonly textarea, selection, and document.execCommand("copy"), then restore focus/selection and remove the node.
- Treat execCommand as a compatibility fallback, not the primary API.
- When both fail, focus/select the rendered code and show localized Ctrl+C/Command+C guidance.
- Never set a copied state unless a method reports success, and disable the action while no code exists.

The helper is unit-tested independently so other Web copy controls can adopt it later without duplicating browser capability checks.

Alternative considered: require HTTPS and remove fallback. Rejected for this change because current self-host documentation and runtime configuration support ordinary HTTP IP access.

### D8 — Pin and verify the external protocol boundary

CAP continues to pin the Codex version in the AIO image. The protocol adapter defines only the request/response/notification shapes it consumes, validated at runtime. Verification generates or reads the pinned Codex App Server JSON schema and confirms those shapes remain present; unit and service tests use a fake duplex JSONL transport and do not contact OpenAI.

A Codex version bump must update the pin and pass this compatibility check. A missing or incompatible method fails the login attempt with a bounded, operator-readable error rather than falling back to terminal-text parsing.

### D9 — Coordinate with the active settings redesign

This change does not modify the frontend-console Settings page with account, GitHub, and Codex sections requirement. Its frontend-console delta adds independent behavior requirements. During apply, preserve the compact direct-dialog shell produced by redesign-settings-single-column and make state/handler changes inside codex-direct-dialog.tsx after reconciling any concurrent edits. The design baseline is refreshed only if the dialog's visible states change an existing screenshot fixture; the page/card composition remains owned by the redesign change.

## Risks / Trade-offs

- [Codex App Server protocol evolves despite the CLI pin] → Validate consumed schemas, keep the version pinned, ignore unknown notifications, and fail closed on malformed known responses.
- [Docker exec stream multiplexing or backpressure corrupts JSONL] → Isolate transport framing in the runner, demultiplex stderr, cap line/buffer sizes, and test fragmented and coalesced frames.
- [The AIO entrypoint has not prepared the gem home when exec starts] → Set numeric user/home explicitly and use a small AbortSignal-bounded filesystem/binary preflight rather than AIO HTTP readiness.
- [API and Web from different releases disagree on the breaking contract] → Ship them in the same CAP release image, validate responses with shared contracts, and do not deploy the Web independently during migration.
- [In-memory terminal status disappears on API restart] → Reclaim workers on shutdown/startup ownership cleanup and show a generic missing-session retry; durable resumption is explicitly out of scope.
- [BoxLite task-provider deployments do not currently stage the AIO login image] → Inspect the pinned image before work, return a stable actionable error, document the retained dependency, and leave a dedicated/BoxLite runner to a follow-up.
- [Legacy clipboard fallback is blocked by a browser] → Never claim success without a positive result; select the visible code and give manual-copy guidance. Continue recommending HTTPS for production.
- [Cancellation reaches Codex after OpenAI already authorized] → The generation guard prevents a cancelled attempt from persisting credentials; cleanup remains idempotent.
- [Active settings redesign edits the same component tree] → Apply/rebase after its dialog shell is stable and keep this change's edits limited to direct-login state and actions.

## Migration Plan

1. Add the new shared contracts and protocol/runner abstractions, labelled orphan cleanup, strict auth validation, and fake-transport tests while leaving the current Web flow unchanged.
2. Replace CodexDeviceLoginService internals with the pre-registered session state machine and Docker App Server runner; add image inspection, ownership labels/startup orphan cleanup, controller routes, no-store headers, lifecycle tests, and remove log parsing/readiness helpers.
3. Switch the Web API binding and direct dialog to the session-scoped two-stage flow, then add the shared copy helper and browser/component tests.
4. Delete obsolete parseDeviceCode tests, detached login-log handling, AIO HTTP readiness use, account-implicit polling/cancellation, and hard-coded OpenAI expiry copy.
5. Run contracts/API/Web verification plus browser checks on localhost and a non-loopback HTTP origin. Reconcile the settings visual baseline only where the new dialog states are intentionally visible.
6. Deploy API and Web together. Existing stored official credentials need no migration.

Rollback is a release rollback of API and Web together. There is no database migration to reverse; temporary sessions are disposable and are reclaimed during process shutdown.

## Open Questions

None block implementation. Exact preparation, local-session, and terminal-observation timeout defaults should remain named server configuration constants and be selected during apply from measured local/Docker startup behavior; their semantics are fixed by the specs even if the initial numeric defaults are tuned.
