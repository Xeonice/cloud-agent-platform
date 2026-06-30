## Context

The terminal behavior under investigation spans two layers: the shared `@cap/ui` xterm wrapper and the web session terminal shell that places xterm inside the fixed-height console cockpit. Existing visual tests intentionally mask the terminal and disable WebSockets, so they protect page composition but not the live terminal's own behavior.

The repository does not currently use Storybook. Adding a TanStack route for stories would be easy to open locally, but it would also become part of the production route graph unless heavily gated. The safer first step is a local-only Vite story harness served only by verification scripts.

## Goals / Non-Goals

**Goals:**

- Provide deterministic local stories for xterm rendering, scrollback, UTF-8 output, and resize behavior.
- Exercise both the raw shared `Terminal` wrapper and a session-shell-sized terminal container.
- Verify that the terminal fills the intended viewport-height slot instead of rendering as a small partial area.
- Verify long output remains scrollable and earlier history is not cleared while new output arrives.
- Keep the story reusable if the project later adopts Storybook.

**Non-Goals:**

- Do not add a production-visible route or public API.
- Do not connect to a real sandbox provider in this change; provider-backed live validation is a separate change.
- Do not redesign the session page or change the browser terminal WebSocket protocol.
- Do not require Storybook as part of this first verification path.

## Decisions

### D1 - Use a local Vite story harness, not a production app route

Create the story entry outside `apps/web/src/routes`, for example under `apps/web/e2e/terminal-stories/`, and serve it with a dedicated Vite/Playwright command. It imports the same app CSS and components but is not part of TanStack Router's generated production route tree.

Alternative considered: add `/__terminal-stories` to the app. That is convenient but risks shipping an internal tool unless every deployment path gates it correctly.

Alternative considered: introduce Storybook immediately. Official React+Vite support exists, but the repository has no Storybook convention today; introducing it just to validate this bug class is more infrastructure than needed.

### D2 - Use deterministic terminal fixtures with imperative probes

The harness should feed the terminal from deterministic fixtures rather than a WebSocket. Fixtures should include:

- Chinese and other multibyte UTF-8 text.
- Split writes where a multibyte character is divided across writes.
- More lines than the visible viewport.
- ANSI cursor-addressed redraw sequences representative of full-screen TUIs.
- Bulk reconnect-style replay followed by continued live writes.

The harness should expose non-production probe data, such as current geometry, last resize event, visible terminal bounds, scroll metrics, and serialized output.

### D3 - Verify parent layout separately from xterm behavior

One story should mount the bare shared `Terminal` in fixed-size containers. Another should mount a session-shell variant that reproduces the app's session height chain: `h-dvh`, `flex flex-col`, header, `flex-1 min-h-0`, terminal article, terminal body.

This separation makes it clear whether a regression is in xterm's fit/addon behavior or in the surrounding cockpit layout.

### D4 - Keep Playwright checks separate from the design-baseline suite

Add a dedicated Playwright spec/config for terminal stories. The current visual suite masks terminal content by design; terminal stories need semantic and geometry assertions, not pixel comparison against the OD baseline.

Assertions should inspect DOM geometry, xterm viewport scrollability, rendered text presence, and resize event values. Screenshots can be captured for debugging but should not become the primary blocking oracle.

## Risks / Trade-offs

- **Risk:** A custom harness drifts from production wiring.
  **Mitigation:** Reuse the production `Terminal` wrapper, session terminal shell styles, and app CSS; keep fixture-only code thin and explicit.
- **Risk:** xterm internals are unstable.
  **Mitigation:** Prefer public APIs and DOM-level observations. Use private xterm internals only where the production wrapper already relies on them.
- **Risk:** Story fixture output can become too synthetic.
  **Mitigation:** Include ANSI patterns copied from real session symptoms: long output, cursor-addressed repaint, split UTF-8 writes, and reconnect-style replay.
- **Risk:** The harness can accidentally ship.
  **Mitigation:** Keep it outside route generation and only launch it from local verification scripts.

## Migration Plan

1. Add the local story harness and deterministic fixtures.
2. Add Playwright terminal-story checks and a package script to run them.
3. Run the checks locally on desktop and mobile viewport sizes.
4. Keep production build behavior unchanged; rollback is deleting the harness and tests.

## Open Questions

- Whether the project should later adopt full Storybook once more component stories exist. This change should not block that; fixtures should remain portable.
