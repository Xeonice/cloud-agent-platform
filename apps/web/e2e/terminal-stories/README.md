# Terminal Stories

This local harness verifies xterm behavior that the console visual baseline
intentionally masks. It is not a TanStack route and is not part of the production
route graph.

## Run

From the repo root:

```bash
pnpm --filter @cap/web terminal-stories:dev
```

Open:

- `http://127.0.0.1:4327/?story=bare`
- `http://127.0.0.1:4327/?story=session`

Run the automated checks:

```bash
pnpm --filter @cap/web test:terminal-stories
```

## What This Covers

- Shared `@cap/ui` `Terminal` mounting and nonblank rendering.
- Session-style height chain where the terminal fills the remaining viewport
  slot.
- Long-output scrollback while later output continues.
- Chinese and split UTF-8 writes.
- Resize reporting through the shared terminal callback.

The provider-backed sandbox path is intentionally out of scope here; it is
covered by the separate provider-backed terminal story change.
