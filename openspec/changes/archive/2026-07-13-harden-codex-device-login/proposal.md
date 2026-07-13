## Why

Connecting an official Codex subscription currently opens an unexplained about:blank tab while a long synchronous backend startup runs, and copying the device code silently fails on supported self-hosted HTTP origins. The same flow scrapes human-facing CLI logs and cannot reliably cancel during startup, so the visible defects are symptoms of a brittle login lifecycle rather than isolated button bugs.

## What Changes

- Replace terminal-log parsing of codex login --device-auth with the structured Codex App Server device-code protocol over its stdio JSON transport.
- Create a CAP login session before background preparation starts and expose explicit preparing, awaiting-authorization, finalizing, connected, cancelled, expired, and error outcomes with race-safe cancellation and cleanup.
- **BREAKING** Change the authenticated settings device-login REST contract from a synchronous code-returning request and account-implicit polling to an asynchronous, session-scoped contract.
- Keep the existing encrypted official-credential persistence boundary, force Codex's file credential store for the temporary worker, and prevent device codes or authentication material from entering application logs or caches.
- Replace the eagerly opened about:blank tab with an in-dialog preparation state followed by a user-activated, opener-safe OpenAI authorization link once the code is ready.
- Add a reusable Web copy utility that prefers the asynchronous Clipboard API, degrades on non-secure HTTP origins, and gives explicit manual-copy guidance instead of failing silently.
- Add protocol, lifecycle, contract, component, and browser coverage for cancellation races, stale completions, insecure-origin copying, and the absence of blank popup tabs.

## Capabilities

### New Capabilities

- codex-device-login: Defines the structured Codex subscription login lifecycle, session-scoped API behavior, secure credential harvesting, cancellation/cleanup guarantees, authorization UX, and resilient device-code copying.

### Modified Capabilities

- frontend-console: Add explicit requirements for the two-stage Codex authorization interaction and resilient device-code copying, without modifying the settings-page layout or compact-dialog composition.

## Impact

- Shared contracts and API surface under packages/contracts and apps/api/src/settings.
- Codex login orchestration, temporary Docker/AIO worker lifecycle, and the pinned Codex App Server protocol.
- Settings Web API bindings and apps/web/src/components/settings/codex-direct-dialog.tsx, plus a shared clipboard helper reusable by other Web copy controls.
- API/service tests, Web component tests, pinned-protocol compatibility checks, and browser verification on secure and non-secure self-host origins.
- The first runner still uses the local Docker/AIO image even when BoxLite is the task provider; this change makes a missing image an immediate stable error but defers provider parity or a dedicated login image.
- No database migration is expected. The existing active settings-layout redesign can proceed independently because this change owns dialog behavior rather than page composition.
