## 1. Track: provider-story-api (depends: none)

- [x] 1.1 Add an explicit env gate for provider-backed terminal story session creation, defaulting to disabled.
- [x] 1.2 Add an internal API service/controller for creating, inspecting, and tearing down temporary provider-backed terminal story sessions.
- [x] 1.3 Ensure story session creation returns only a CAP story/session id and never returns provider-native terminal URLs or provider credentials.
- [x] 1.4 Add TTL and best-effort cleanup for temporary story sessions and backing sandbox resources.
- [x] 1.5 Add tests proving story creation is disabled by default and creates no provider resource when disabled.

## 2. Track: provider-fixture-runtime (depends: provider-story-api)

- [x] 2.1 Implement a deterministic shell/PTY fixture that runs inside the selected sandbox provider.
- [x] 2.2 Make the fixture emit known Chinese UTF-8 text, split-safe output markers, many scrollback lines, and resize-sensitive geometry markers.
- [x] 2.3 Make the fixture echo operator input so Playwright can prove keystrokes reach the provider-backed PTY.
- [x] 2.4 Wire the fixture through CAP's existing terminal pty seam and TerminalGateway browser protocol.
- [x] 2.5 Add backend tests for fixture lifecycle, input routing, resize routing, and teardown.

## 3. Track: provider-readiness (depends: provider-story-api)

- [x] 3.1 Add selected-provider readiness reporting for the story path, including the provider id used by the fixture.
- [x] 3.2 Add fail-closed behavior when an explicitly selected provider is not ready.
- [x] 3.3 Validate AIO prerequisites for the default local provider path.
- [x] 3.4 Validate BoxLite prerequisites: `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, `BOXLITE_IMAGE`/image map, `BOXLITE_TERMINAL_MODE=pty`, and terminal capabilities.
- [x] 3.5 Add tests proving explicit BoxLite selection does not silently fall back to AIO.

## 4. Track: provider-story-ui (depends: provider-story-api, provider-fixture-runtime)

- [x] 4.1 Add a local-only provider-backed terminal story UI outside the production route graph.
- [x] 4.2 Reuse the browser `TerminalSocket` protocol to connect the story UI to CAP's `/terminal` gateway with the returned story/session id.
- [x] 4.3 Show provider id, readiness state, story session id, and teardown status in the local story UI.
- [x] 4.4 Ensure the story UI never renders provider-native URLs, tokens, or sandbox internals.
- [x] 4.5 Add UI-level checks for not-enabled and provider-readiness failure states.

## 5. Track: provider-story-verification (depends: provider-readiness, provider-story-ui)

- [x] 5.1 Add an opt-in Playwright/e2e command that creates a provider-backed story session, opens the story UI, and tears the session down in `finally`/cleanup hooks.
- [x] 5.2 Verify live provider output reaches xterm through CAP's gateway.
- [x] 5.3 Verify operator input reaches the provider-backed PTY and is echoed by the fixture.
- [x] 5.4 Verify browser resize reaches the provider fixture and updates geometry markers.
- [x] 5.5 Verify UTF-8 output renders correctly and long scrollback remains reachable.
- [x] 5.6 Verify reconnect replay restores previous fixture output and continues streaming new output.
- [x] 5.7 Run the verification against the local AIO provider and record results.
- [x] 5.8 Run the verification against a real configured BoxLite endpoint when env is available and record results; otherwise record the exact skipped prerequisite.

## 6. Track: docs-and-scripts (depends: provider-story-verification)

- [x] 6.1 Document required env flags and provider-specific prerequisites for running the provider-backed terminal story.
- [x] 6.2 Document how to run AIO and BoxLite provider-backed verification locally.
- [x] 6.3 Document cleanup behavior and how to inspect leftover temporary sessions if cleanup fails.
- [x] 6.4 Run affected backend/frontend typecheck, lint, unit tests, and opt-in provider story checks; record skipped checks with reasons.
