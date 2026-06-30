## Why

The live xterm surface has repeatedly regressed in areas that ordinary unit tests and masked pixel baselines do not cover: partial-height rendering, scrollback usability, UTF-8 output, and resize propagation. We need a local, repeatable story-level verification surface so these failures can be reproduced before release.

## What Changes

- Add an xterm-focused local story/harness for the shared `@cap/ui` terminal and the web session terminal shell.
- Exercise deterministic cases for full-height layout, long scrollback, UTF-8 text, split UTF-8 writes, reconnect-style bulk replay, and resize reporting.
- Add Playwright verification for the story so the terminal is nonblank, fills its intended container, retains scrollback, renders Chinese text, and reports geometry changes.
- Keep the story local/development-only; it must not add production routes or alter the browser terminal protocol.
- Reuse fixtures and assertions in a way that can later move into Storybook if the project adopts `@storybook/react-vite`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `realtime-terminal`: add a required local xterm story/harness that verifies the terminal rendering, scrollback, UTF-8, and resize behaviors already required by the live terminal spec.

## Impact

- Frontend terminal code and fixtures:
  - `packages/ui/src/terminal/terminal.tsx`
  - `apps/web/src/components/session/session-terminal.tsx`
  - new web-local story/harness components or routes
  - new terminal fixture utilities for deterministic output
- Verification:
  - new Playwright story checks separate from the existing masked design-baseline suite
- No database migration, public REST API change, browser terminal protocol change, or sandbox provider behavior change is expected.
