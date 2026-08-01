# apps/api — the orchestrator

The NestJS service. It accepts tasks, admits them, provisions a sandbox per task,
runs an agent inside it, and settles the result. Roughly 450 source files.

This is a leaf: **nothing imports `@cap-console/api`.** If you are looking for a
reusable piece, it is not here.

## What this subtree may depend on

`@cap-console/contracts` · `@cap-console/sandbox` · `@cap-console/sandbox-conformance`

## What must not happen here

These are enforced by `src/sandbox/sandbox-package-boundary.test.mjs`; the
wording is that gate's own:

- concrete provider factories belong in `@cap-console/sandbox` or the provider
  packages — not here
- Docker or provider lifecycle must not be implemented in `src/sandbox` or
  `src/terminal`
- provider env and family parsing must stay behind the sandbox host harness
- provider terminal clients and transports must live behind the sandbox terminal
  harness
- provider protocol strings must not be registered or switched on in api code
- the api must not export a provider class

Import `@cap-console/sandbox`, the facade. **Importing a `@cap-console/sandbox-*`
sub-package directly fails the gate.**

Directory layout is enforced too, by `scripts/api-module-layout-check.mjs`:
imports inside `src/` use the `@/` alias rather than `../` traversal, and two
top-level directories under `src/` may not import each other outside DI
composition. The permitted-cycle list is empty and is meant to stay empty.

## Where things are that you might look for here

| you are looking for | it lives in |
|---|---|
| the set of agent runtimes that exist | `packages/contracts/src/agent-runtime-id.ts` — one declaration, everything derives |
| request/response shapes, WS frame protocol | `@cap-console/contracts` |
| anything the console renders | `apps/web` — this subtree serves data, it does not know about pages |
| a sandbox provider's actual implementation | `packages/sandbox-provider-*` |

## Verifying a change

```bash
pnpm --filter @cap-console/api typecheck
pnpm --filter @cap-console/api lint
pnpm --filter @cap-console/api test
node scripts/api-module-layout-check.mjs
```

`test` runs three suites: compiled (`dist`), source (`*.test.mjs`), and a
harness suite. **Build before running the compiled one** — it executes `dist`, so
a stale build tests stale code:

```bash
pnpm exec turbo run build --filter=@cap-console/api
```

## Two things that have bitten before

**Test counts are evidence.** A suite that passes with fewer tests than before has
usually lost coverage silently rather than gained speed. Compare counts, not just
exit codes.

**`scripts/boot-smoke.sh` needs a `DATABASE_URL`** and currently fails on macOS at
the default-admin seed step for reasons unrelated to any recent change. It passes
in CI. Do not treat a local failure there as a regression without attributing it.
