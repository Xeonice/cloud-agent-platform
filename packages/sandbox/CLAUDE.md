# packages/sandbox — providers behind one port

The facade over the sandbox provider implementations. `apps/api` imports this
package and nothing below it.

This directory is the entry point for a cluster:

```
@cap-console/sandbox                 ← the facade; api imports only this
  ├── sandbox-core                   the port, capability classes, shared types
  ├── sandbox-provider-aio           AIO provider
  ├── sandbox-provider-boxlite       BoxLite provider
  ├── sandbox-cloud-http             HTTP cloud provider
  ├── sandbox-environment            provider-neutral environment model
  └── sandbox-conformance            the suite every provider must pass
```

## What this subtree may depend on

`@cap-console/contracts` · `@cap-console/sandbox-core` ·
`@cap-console/sandbox-environment` · `@cap-console/sandbox-cloud-http` ·
`@cap-console/sandbox-provider-aio` · `@cap-console/sandbox-provider-boxlite` ·
`@cap-console/sandbox-conformance`

Downward, into the cluster it fronts — never sideways or up. 工件02 A 表 P4 is
the rule underneath that: a package may not reach into `apps/*`, so nothing here
may import the api it serves. The declaration above is reconciled against
`docs/refactor/boundaries-manifest.json` by
`scripts/claude-md-dependency-reconcile.mjs`.

## The invariant this cluster exists to hold

**One shared interface, N implementations.** A provider is added by implementing
the port and passing the conformance suite — not by adding a branch anywhere else.
Two rules follow, and both are enforced rather than requested:

- `apps/api` may import `@cap-console/sandbox` but **not** any
  `@cap-console/sandbox-*` sub-package. Enforced by
  `apps/api/src/sandbox/sandbox-package-boundary.test.mjs`.
- `@cap-console/sandbox-environment` must stay provider-neutral and
  framework-free. Enforced by its own `test/package-boundary.test.mjs`.

Provider families are declared once in
`packages/contracts/src/provider-family.ts` and derived everywhere else. A surface
that legitimately admits more (a diagnostic emitted before a provider is chosen)
states that as an explicit extension of that list, not as a second array.

## Where things are that you might look for here

| you are looking for | it lives in |
|---|---|
| the port a provider implements | `packages/sandbox-core` |
| what a provider must satisfy | `packages/sandbox-conformance` |
| which families exist | `packages/contracts/src/provider-family.ts` |
| how a task decides to provision | `apps/api` — this cluster provisions; it does not decide |

## Verifying a change

```bash
pnpm --filter @cap-console/sandbox typecheck
pnpm --filter @cap-console/sandbox lint
pnpm test:sandbox        # the whole cluster, in dependency order
```

`pnpm test:sandbox` runs core, conformance, cloud-http, both providers, and the
facade. Running only the package you edited is how a provider drifts from the
port it claims to implement.
