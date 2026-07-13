# Research brief: harden Codex device login

## Problem statement

CAP's official Codex subscription connection currently exposes two visible failures:

1. The browser opens an about:blank tab synchronously, then leaves it blank while the API provisions a temporary AIO container, waits for its HTTP service, starts Codex, and scrapes a device code from a log.
2. The copy action silently depends on the asynchronous Clipboard API, which is unavailable on ordinary non-secure HTTP origins used by supported self-host deployments.

The same lifecycle also has a hidden correctness issue: the server records the active login session only after the device code has been discovered. Closing the dialog during preparation therefore cannot cancel the work, and a late completion can race with cancellation or a later retry.

## Current implementation evidence

- apps/web/src/components/settings/codex-direct-dialog.tsx opens about:blank inside the initial click to preserve transient browser activation, awaits POST /settings/codex/device-login, then redirects the retained window handle.
- The same dialog calls navigator.clipboard.writeText when present and silently ignores absence or rejection.
- apps/api/src/settings/codex-device-login.service.ts creates a temporary container from AIO_SANDBOX_IMAGE, waits up to the configured AIO readiness timeout for /v1/docs, launches codex login --device-auth through /v1/shell/exec, and scans a log for up to 25 seconds.
- The service stores the session in its account-keyed map only after parsing the verification URL and user code. DELETE during the starting window therefore has no mapped session to tear down.
- The public contract has no session identifier or preparing/cancelled/finalizing state. POST returns the device code synchronously, while GET can only report awaiting_authorization, connected, expired, or error.
- The implementation hard-codes a displayed 15-minute expiry and separately reclaims a session after two minutes without frontend polling.
- The temporary login flow requires the AIO image even when the deployment's task sandbox provider is BoxLite. A prior production incident surfaced this dependency as a Docker No such image response.

## External research

### Official Codex integration surface

Current Codex exposes a structured device-code flow through codex app-server:

- account/login/start with type chatgptDeviceCode returns loginId, verificationUrl, and userCode.
- account/login/completed notifies the client of completion.
- account/login/cancel cancels a login after loginId exists.
- The default stdio transport is newline-delimited JSON; the WebSocket transport is explicitly experimental and unsupported.
- The frontend is expected to own presentation of the verification URL and user code.

CAP's pinned Codex 0.144.1 contains these protocol types, so adopting the flow does not require an unrelated version upgrade. Direct codex login --device-auth has no JSON output mode, making the existing ANSI/log parser inherently coupled to human-facing output.

Codex may persist credentials either to auth.json or an operating-system credential store. The login worker must explicitly select the file credential store so CAP can continue harvesting auth.json and passing it through the existing encrypted SettingsService boundary.

### OAuth device-flow boundary

RFC 8628 requires the client to display the verification URI and user code, while the OAuth client performs token polling. CAP should continue delegating OpenAI token polling to Codex rather than calling OpenAI's internal device endpoints or implementing interval/slow_down behavior itself. A verification URI containing the code must only be used when the authorization server explicitly supplies one; CAP must not construct it.

### Browser constraints

Browser transient activation for popup-gated APIs lasts at most a few seconds. It cannot be retained across the current container cold start. A second explicit user action after the code is ready is therefore the reliable primary UX.

The asynchronous Clipboard API is restricted to secure contexts. HTTP loopback/localhost can be considered trustworthy, but an ordinary LAN or Tailscale IP over HTTP is not. CAP must prefer the modern API where available and provide a compatibility fallback plus visible manual-copy recovery.

## Options considered

### A. UI-only patch around the current backend

Remove about:blank, wait for the existing POST, then display the device code and a user-clicked link; add clipboard fallback.

This fixes both visible symptoms with a small diff, but preserves the long request, log parser, uncancellable startup window, stale-result race, and dependency on AIO HTTP readiness. It is useful only as an interim rollout step.

### B. Structured App Server runner in the existing temporary container

Create the CAP session first, start the existing temporary container in background work, attach a non-TTY Docker exec running codex app-server over stdio, and exchange structured JSON messages.

This is the recommended bounded change. It keeps the existing image and encrypted credential-storage boundary, removes dependence on AIO's HTTP shell/readiness path, gains a supported login identifier and completion/cancel events, and eliminates human-text parsing. A small bounded check may still be needed for the container user/home environment before starting Codex.

### C. Call OpenAI device endpoints directly

Rejected. Those endpoints are not a public CAP integration contract, would make CAP its own OAuth client, and would duplicate polling, workspace, token-exchange, and credential semantics already maintained by Codex.

### D. Build a new provider-neutral or dedicated login image immediately

Deferred. A narrow CodexDeviceLoginRunner boundary should keep orchestration independent from the business service and allow a dedicated or BoxLite-backed worker later, but replacing the image/provider model is not necessary to fix the reported issues.

## Recommended product contract

CAP owns a per-account, per-attempt session:

preparing -> awaiting_authorization -> finalizing -> connected

Any nonterminal stage may end in cancelled, expired, or error. The server creates sessionId before asynchronous preparation and uses an internal generation/token check so an old worker cannot update a cancelled or superseded attempt.

- POST creates the attempt and returns HTTP 202 with sessionId and preparing.
- GET is scoped to sessionId and returns the current state. verificationUri and userCode appear only while awaiting authorization.
- DELETE is scoped to sessionId, marks cancellation before cleanup, sends account/login/cancel when loginId is available, terminates the worker otherwise, and is idempotent.
- Credentials and device codes are never written to application logs. Login responses are non-cacheable.
- The fixed CAP session timeout is described as a local session limit, not as an asserted OpenAI code lifetime.

The dialog remains in place while preparing. Once awaiting_authorization, it shows the code and a normal user-clicked OpenAI link using target=_blank with noopener/noreferrer. It never creates an about:blank window. Closing or retrying cancels the exact session.

A shared copyText utility:

1. uses navigator.clipboard.writeText in a secure context;
2. uses a synchronous offscreen selection/copy compatibility path when the modern API is absent or unusable;
3. reports success/failure explicitly;
4. selects the visible code and prompts for Ctrl+C or Command+C if both paths fail.

## Verification implications

- Protocol adapter unit tests with a fake JSONL transport: initialize handshake, structured login start, completion, cancel, malformed responses, process exit, and timeouts.
- Service lifecycle tests: cancel during preparation, retry superseding an old attempt, stale completion rejection, cleanup on every terminal path, module shutdown, and per-account isolation.
- Contract/controller tests for HTTP 202, session scoping, state transitions, idempotent DELETE, and no-store responses.
- Frontend tests for preparing/awaiting/finalizing/error states, no about:blank call, safe external-link attributes, copy success, compatibility fallback, and explicit failure guidance.
- Browser verification on localhost and on a non-loopback HTTP origin, plus the existing settings visual baseline where the active redesign change requires it.
- A pinned-version compatibility check generated from codex app-server's JSON schema, without performing a real OpenAI login in CI.

## Primary sources

- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/auth
- https://www.rfc-editor.org/rfc/rfc8628
- https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation
- https://www.w3.org/TR/clipboard-apis/
- https://www.w3.org/TR/secure-contexts/
