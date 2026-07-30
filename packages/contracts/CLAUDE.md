# packages/contracts — the shared protocol

The one package both sides depend on. 45 modules. Zod schemas plus the types
inferred from them, covering REST bodies, the WebSocket frame protocol, and the
vocabularies that say which kinds of things exist.

Depended on by: `@cap-console/web`, `@cap-console/api`, `@cap-console/ui`,
`@cap-console/sandbox`, `@cap-console/sandbox-hooks`.

Depends on: nothing but tooling config.

## Why edits here cost more than they look

A change in this package can reach both the console and the orchestrator in the
same commit. That is the point of the package — but it means a shape change here
is a change to a protocol two runtimes speak, not to a local type. In particular:

- **The frame protocol is not REST.** `ws-frames`, `terminal-attachment-frames`,
  `write-lock-frames`, `control-frame`, `terminal-bytes`, `approvals` are a live
  bidirectional protocol with flow control and byte limits. Browser and server run
  the same vocabulary; changing one side alone is not possible from here, which is
  the safety property, not an inconvenience.
- **The console runs these schemas, not just these types.** It validates api
  responses against the same zod objects the api validates with. A schema is
  runtime behaviour on both ends.

## The pattern this package uses for "which kinds exist"

One `as const` declaration, everything else derived:

```ts
export const AGENT_RUNTIME_IDS = ['claude-code', 'codex'] as const;
export type AgentRuntimeId = (typeof AGENT_RUNTIME_IDS)[number];
```

`SANDBOX_PROVIDER_FAMILIES` and `AGENT_RUNTIME_IDS` both work this way, and
consumers build total `Record`s over them so that adding a member is a compile
error at every place that has to decide something about it — rather than a silent
default.

**If you add a vocabulary, declare it once and derive.** A second hand-written
copy of a set is the defect this package has already had twice.

## Verifying a change

```bash
pnpm --filter @cap-console/contracts build      # consumers read dist
pnpm --filter @cap-console/contracts test
pnpm --filter @cap-console/contracts typecheck
```

Then the consumers, because that is where a shape change actually lands:

```bash
pnpm --filter @cap-console/api typecheck
pnpm --filter @cap-console/web typecheck
```

## One caution

This package is scheduled to become a published npm package
(`docs/repo-split-epic.md`). Nothing about that has happened yet — it is still a
workspace package — but it does mean the module boundary here is the one most
likely to become a real distribution boundary later. Keep exports intentional.
