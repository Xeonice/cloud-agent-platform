## Research Brief

### Codebase Findings

- The shared xterm wrapper is `packages/ui/src/terminal/terminal.tsx`. It owns lazy xterm loading, fit/serialize/unicode11 addons, resize reporting, scrollback configuration, viewport sync, refresh, focus, and imperative write/resize APIs.
- The live session integration is `apps/web/src/components/session/session-terminal.tsx`. It strips tmux alt-screen switches, writes raw PTY bytes, ACKs after xterm flush, sends browser geometry on socket open and resize, queues hidden reconnect replay, exposes fullscreen/pause/copy controls, and overlays a fallback only when xterm fails.
- The task route is `apps/web/src/routes/_app/tasks/$taskId.tsx`. The terminal section expects a fixed-height app shell and `flex-1 min-h-0` ancestry to fill the space below `SessionHeader`.
- The app shell is `apps/web/src/routes/_app.tsx` plus `SidebarInset` in `apps/web/src/components/ui/sidebar.tsx`. Session pages pin the inset to `h-dvh overflow-hidden`; a story must replicate this parent height chain to catch partial-height regressions.
- Existing visual tests deliberately mask the terminal and set `VITE_WS_URL` empty, so the current pixel baseline suite cannot validate live xterm rendering, scrollback, UTF-8, or geometry behavior.
- There is no Storybook setup or `.stories` convention today. The web app uses Vite, Vitest, and Playwright; adding Storybook is possible but would be new infrastructure.

### Prior OpenSpec Context

- `fix-terminal-utf8-resize` already addressed UTF-8 and tmux geometry transport behavior at the API/provider layer.
- `fix-live-terminal-refresh-replay` strengthened frontend reconnect replay, viewport sync, scrollback behavior, and stale input handling.
- `realtime-terminal` already specifies UTF-8 frame-boundary preservation, browser geometry sync, xterm scrollback, headless-vs-interactive branching, and provider-neutral gateway behavior. The gap is a reusable local story/harness that exercises those properties visually and mechanically.

### External References

- Storybook React+Vite official docs support installing `@storybook/react-vite` and using `.storybook/main.ts` with `framework: '@storybook/react-vite'`: https://storybook.js.org/docs/get-started/frameworks/react-vite
- Storybook is suitable for isolated component stories, but this repository has no existing Storybook dependency. A Vite dev-only story route is lower-friction and can still be validated by Playwright.

### Recommended Direction

Build a local xterm story/harness in the existing Vite web workspace rather than making Storybook a prerequisite for the first step. The story should mount the same `Terminal` wrapper and a session-shell variant under controlled container sizes, feed deterministic output fixtures, expose geometry/scrollback probes, and include Playwright checks. If Storybook is later introduced, the same fixtures can be reused in CSF stories.
