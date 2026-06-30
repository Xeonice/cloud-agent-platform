## 1. Track: terminal-story-harness (depends: none)

- [x] 1.1 Create a local-only terminal story entry outside `apps/web/src/routes` so it is not included in the production route graph.
- [x] 1.2 Import the app terminal styles and mount the shared `@cap/ui` `Terminal` wrapper in a bare fixed-size story.
- [x] 1.3 Add a session-shell story that reproduces the session page height chain: header, `flex-1 min-h-0` body, terminal article, and xterm host.
- [x] 1.4 Add deterministic fixture writers for long output, Chinese UTF-8 text, split UTF-8 chunks, cursor-addressed redraws, and reconnect-style bulk replay.
- [x] 1.5 Expose story probe state for geometry, resize events, terminal bounds, scroll metrics, and serialized terminal text.

## 2. Track: terminal-story-verification (depends: terminal-story-harness)

- [x] 2.1 Add a dedicated Playwright config or test command for terminal stories, separate from the masked design-baseline visual suite.
- [x] 2.2 Assert the bare terminal story mounts a nonblank xterm surface and reports nonzero cols/rows.
- [x] 2.3 Assert the session-shell story fills the intended viewport-height slot on desktop and mobile viewports.
- [x] 2.4 Assert long output leaves earlier history reachable by scrolling upward while newer output continues arriving.
- [x] 2.5 Assert Chinese and split UTF-8 fixture text renders without underscores or replacement characters.
- [x] 2.6 Assert container resizing changes the reported xterm geometry.

## 3. Track: package-and-docs (depends: terminal-story-verification)

- [x] 3.1 Add package scripts or documented commands for running the terminal story server and verification suite.
- [x] 3.2 Document why terminal stories are separate from the design-baseline suite and how to inspect them locally.
- [x] 3.3 Run the terminal story verification locally and record the command output in the implementation notes or verification summary.
- [x] 3.4 Run affected web typecheck/lint/test commands and record any skipped checks with reasons.
