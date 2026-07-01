## 1. Track: terminal-provenance (depends: none)

- [x] 1.1 Extend the provider-neutral terminal output seam so output chunks can carry recordable vs non-recordable provenance without changing the browser WebSocket protocol.
- [x] 1.2 Update `AioPtyClient` readoption attach handling to mark alive-session attach bootstrap output as non-recordable and later live agent output as recordable again.
- [x] 1.3 Add focused AIO terminal tests proving alive-session attach output can be observed by the live viewer while carrying non-recordable provenance.

## 2. Track: durable-history-continuity (depends: terminal-provenance)

- [x] 2.1 Update `TerminalGateway.onPtyOutput` and related append paths to skip `session.log` and `session.cast` writes for non-recordable output while preserving live streaming.
- [x] 2.2 Make `session.cast` recording resumable: avoid writing a second header for an existing cast and continue event timestamps from the last valid event time.
- [x] 2.3 Rebase `SnapshotManager` or gateway reconnect bookkeeping from existing `session.log` size during readoption so durable replay offsets remain aligned.
- [x] 2.4 Add backend tests for resumed casts, monotonic cast event times, skipped non-recordable history writes, and readoption replay offset alignment.

## 3. Track: legacy-cast-compat (depends: none)

- [x] 3.1 Add cast parser or cast-log helper support for detecting mid-file asciicast headers and event time regressions.
- [x] 3.2 Prevent detected legacy readoption bootstrap segments from rendering as ordinary chronological terminal history, without rewriting the raw cast file.
- [x] 3.3 Add frontend/contracts tests using a multi-header fixture modeled after task `12c791c7-87df-4150-a941-d94bb4374460`.

## 4. Track: verification (depends: durable-history-continuity, legacy-cast-compat)

- [x] 4.1 Add or update an integration scenario for running task API restart/readoption that asserts no second `session.cast` header is written.
- [x] 4.2 Verify the same scenario asserts no `duplicate session:` or attach bootstrap bytes are appended to new `session.log` / `session.cast` history after readoption.
- [x] 4.3 Run focused API/provider/web tests for terminal replay, cast parsing, and readoption history continuity.
- [x] 4.4 Document the verification result in the change notes or task completion comments before implementation is considered complete.

Verification:

- `pnpm --filter @cap/api build`
- `pnpm --filter @cap/api test:terminal-src`
- `pnpm --filter @cap/sandbox build && node packages/sandbox/test/terminal-reconnect.test.mjs`
- `pnpm --filter @cap/sandbox-provider-aio build && node packages/sandbox-provider-aio/test/aio-pty-client-runtime.test.mjs`
- `pnpm --filter @cap/contracts build && node packages/contracts/src/asciicast.test.mjs`
- `pnpm --filter @cap/web test -- src/components/session/cast-log.test.ts`
- `pnpm --filter @cap/api lint`
- `pnpm --filter @cap/sandbox-provider-aio lint`
- `pnpm --filter @cap/contracts lint`
- `pnpm --filter @cap/web typecheck`
