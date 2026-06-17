# Session Replay (terminal tab — asciicast + xterm timing player) — Tasks

> Track 1 (Contracts) is the shared base. Tracks 2 and 3 are parallel-safe (writer vs reader). Track 4 depends on Track 1. Each track ships its own tests (per CLAUDE.md: all changes ship with tests; no hardcoding to satisfy tests).

## 1. Contracts (base — do first)

- [x] 1.1 In `packages/contracts`, add the asciicast v2 shapes: header `{ version: 2, width, height, timestamp?, env? }` + event tuple `[time, code, data]`. Export parse helpers (`parseAsciicastHeader`, `parseAsciicastEvent`, `parseCast`) + `castDurationSeconds`.
- [x] 1.2 Define the cast endpoint shape: `castEndpointPath(id)` + `CAST_CONTENT_TYPE`, the single source of truth imported by api + web.
- [x] 1.3 Contracts unit test: valid header + `o`/`r` lines parse; a malformed line is dropped without aborting the whole parse; endpoint path/content-type contracts stable. (`asciicast.test.mjs`, 8 pass)

## 2. asciicast writer (gateway — parallel with Track 3)

- [x] 2.1 Add `SESSION_CAST_FILENAME` + `SnapshotManager` `cols`/`rows` getters to `snapshot.ts`. In `terminal.gateway.ts`, register a per-task `sessionCasts` entry on session open and write the asciicast v2 header once (geometry from `snapshots.cols/rows`, `timestamp` = epoch s, `startMs` anchors `time`).
- [x] 2.2 In the EXISTING PTY-output hook (after `appendSessionLog`, NOT altering it / the lockstep), append one `[ (Date.now()-startMs)/1000, "o", data ]` per chunk; in `onResize` append `[ t, "r", "<cols>x<rows>" ]`.
- [x] 2.3 UTF-8: verified `onPtyOutput(chunk: string)` is an already-decoded UTF-8 string (AioPtyClient decodes upstream), so `JSON.stringify` yields valid UTF-8 `data` with no split-multibyte risk at this layer (the boundary is handled upstream). Covered by a multibyte round-trip test.
- [x] 2.4 `session.cast` writes are best-effort: own per-task tail chain, log + swallow failures, never block streaming or the `session.log` write. `unregisterSession` drops the cast state.
- [x] 2.5 Unit tests: pure builders extracted to `cast-writer.ts` — header geometry/timestamp, `o` line + cumulative `time` + JSON-escaped data, multibyte round-trip, `r` line `"COLSxROWS"`. (`cast-writer.test.mjs`, 9 pass)

## 3. Cast read endpoint (api — parallel with Track 2)

- [x] 3.1 Add `SessionCastController` (`GET tasks/:id/cast`, mirroring `session-history.controller`) behind the global `APP_GUARD`; 404 (via `TasksService.findById`) for an unknown task.
- [x] 3.2 Read `workspaces/<id>/session.cast` via the shared `resolveWorkspaceDir` (no manual join of unsanitized input → no traversal); serve `text/plain` (`CAST_CONTENT_TYPE`).
- [x] 3.3 Empty signal: absent/empty/whitespace cast → empty body (200); a read error degrades to empty (never 500). Registered in `tasks.module`.
- [x] 3.4 Controller tests: available → text; empty/whitespace → ''; absent → '' (no 500); unknown task → findById 404 propagates. (`session-cast.controller.test.mjs`, 4 pass)

## 4. Web replay timing-player (depends on Track 1; consumes Track 3)

- [x] 4.1 Add `getSessionCast(id)` text fetch to `real.ts` (bearer auth, 404→''). Add `resize(cols,rows)` to `@cap/ui` `TerminalHandle` so the player can match the recording geometry.
- [x] 4.2 New `SessionCastPlayer` (`session-cast-player.tsx`): client-only read-only `@cap/ui <Terminal>` (`onData` omitted) + the live terminal's `--terminal-*` theme; fetch the cast in an effect, `parseCast`, size to the header geometry.
- [x] 4.3 Timing engine: a rAF loop drives `applyWindow(events, prev, next, idx, handlers)` on the recorded clock × speed; `o` ⇒ `write`, `r` ⇒ `resize`. (Pure helpers in `cast-playback.ts`.)
- [x] 4.4 Player UI: play/pause, a seekable progress bar (current/total time), speed (1×/2×/4×). Seek = `clear()` + `rebuildStateUpTo(events, T)` (state-machine rebuild) then resume.
- [x] 4.5 Honest empty/error faces; purely read-only (no input/socket/lease/asciinema-player); never fabricate a frame. Wire `SessionCastPlayer` into `session-replay.tsx`'s 终端回放 tab (the existing 对话记录 tab already renders the rollout transcript).
- [x] 4.6 Front-end tests: `parseResizeData`, `applyEvent` (o/r/i/m), `applyWindow` (once-each across windows + index advance), `rebuildStateUpTo` (seek). (`cast-playback.test.ts`, 10 pass)

## 5. Finalize (after the player works — live environment)

- [ ] 5.1 End-to-end verification against a real finished task: the 终端回放 tab plays `session.cast`, the codex alt-buffer TUI evolves over time with correct colors/geometry, play/pause/seek/speed work; empty face for a no-output task.
- [ ] 5.2 Measure real `session.cast` size/duration; decide whether seek needs periodic state snapshots (only if it feels heavy) — do NOT pre-optimize.
