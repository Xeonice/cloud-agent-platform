# apps/web — the console

The TanStack Start application an operator uses: task list, task creation, the
live terminal, settings, history. 261 source files.

This is a leaf: **nothing imports `@cap-console/web`.**

## What this subtree may depend on

`@cap-console/contracts` · `@cap-console/ui`

**It cannot reach `apps/api`.** There is no dependency between them and never has
been — the two share exactly one thing, `@cap-console/contracts`, and both depend
on it rather than on each other. If a change here seems to need something from the
api, what it actually needs is either a contract addition or an endpoint, and
neither is written in this subtree.

## Where things are that you might look for here

This is the routing that matters most in this subtree, because a local search
returns plausible-looking hits for all of them:

| you are looking for | it lives in |
|---|---|
| which agent runtimes exist | `packages/contracts/src/agent-runtime-id.ts` — one declaration. A search for `runtime` returns 58 hits here and none of them is the answer |
| what an API response looks like | `@cap-console/contracts` — the console validates against the same zod schemas the api serves |
| the WebSocket frame protocol | `@cap-console/contracts` — `ws-frames`, `terminal-attachment-frames`, `write-lock-frames`, `control-frame`. Both ends run the same vocabulary and the same byte limits |
| why an endpoint returns what it does | `apps/api` |

`src/lib/api/real.ts` is the seam where this subtree meets the api. Types there
derive from the contract; a locally re-declared shape is a bug waiting to drift.

## Verifying a change

```bash
pnpm --filter @cap-console/web typecheck
pnpm --filter @cap-console/web lint
pnpm --filter @cap-console/web test
```

Visual changes have a pixel baseline; `pnpm --filter @cap-console/web test`
covers the component and unit suites, and the design baseline lives under
`e2e/design-baseline`.

## One thing worth knowing

The console reads its runtime list from `GET /runtimes` at runtime rather than
from a compiled-in list, deliberately: a console pinned to the runtimes it shipped
with would silently hide one a newer api offers. When you touch a picker, keep the
list coming from the server and keep the per-runtime copy in a total mapping, so
adding a runtime is a build error here rather than a silent omission.
