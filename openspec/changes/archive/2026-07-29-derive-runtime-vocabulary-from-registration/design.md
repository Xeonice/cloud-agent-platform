## Context

Four independent statements of "which runtimes exist", measured on the working
tree at `12ce743`:

```
packages/contracts/src/task.ts:61            z.enum(['claude-code','codex'])
apps/api/src/agent-runtime/agent-runtime.port.ts:37   type RuntimeId = 'codex' | 'claude-code'
apps/api/src/agent-runtime/agent-runtime.integration.ts:150
    new AgentRuntimeRegistry([new CodexRuntime(), new ClaudeCodeRuntime()])
apps/web/src/lib/api/real.ts:155             type RuntimeId = "claude-code" | "codex"
```

The fourth was found by measurement rather than by reading, and it is the one that
should not exist at all: the console already depends on `@cap/contracts`.

Nothing reconciles them — a grep for any comparison between them returns zero
hits. The contract states the arrangement plainly: the enum is "kept byte-for-byte
in sync with the values the api runtime registry resolves by". That is a promise
in a comment.

`RuntimeSchema` is consumed at 8 further positions across `task`, `schedule`,
`runtime.ts`, `runtime-model`, and `public-v1-operations` — including
`RuntimeReadinessSchema.id`, so `GET /runtimes`, whose job is to publish which
runtimes exist, validates its own response against the frozen list.

The registry's `isRegistered` docstring says "registering a third runtime needs no
edit here". Three lines below, its signature is
`isRegistered(value: string): value is RuntimeId`, narrowing to the hand-written
union — so a third runtime cannot be held without editing it. The claim is false
in the file that makes it.

Constraints and enabling facts:

- The neighbouring axis already has the shape this change wants:
  `SANDBOX_PROVIDER_FAMILIES` is one `as const` list and
  `TaskProvisioningDiagnosticProviderFamilySchema` derives from it.
- `Task.runtime` is `String?` in Prisma with no DB-level constraint.
- The console reads the runtime list from `GET /runtimes` at runtime, not from a
  compiled-in list.
- There are **zero** exhaustive `switch` sites on the `Runtime` union, so widening
  it costs no existing type safety.
- `DEFAULT_TASK_RUNTIME` (contracts) and `DEFAULT_RUNTIME_ID` (api) are two more
  spellings of the same default, each `satisfies` its own copy of the union.

## Goals / Non-Goals

**Goals:**

- One declaration of the runtime vocabulary; every other statement derives.
- Registration and declaration reconciled by something that fails, not by prose.
- Adding a third runtime costs one declaration line and one registration, and
  anything else it costs is surfaced as a compile error rather than discovered.
- Identical accepted and rejected values, identical wire shapes.

**Non-Goals:**

- Implementing a third runtime.
- The provider axis's second vocabulary (`ConfiguredSandboxProviderFamily`).
- Changing what a runtime is: the policy/mechanism split, capability
  declarations, and model-selection contract are untouched.
- Operator-configurable runtime sets. The declaration stays a source-level fact.

## Decisions

### D1 — The vocabulary is one `as const` list in `@cap/contracts`

`AGENT_RUNTIME_IDS = ['claude-code', 'codex'] as const`, with `RuntimeSchema`
derived via `z.enum` and `Runtime` derived from the schema. This mirrors
`SANDBOX_PROVIDER_FAMILIES` exactly, so the two axes stop being asymmetric.

It stays in `contracts` rather than moving to the api because the API-boundary
validator lives there and is consumed by the frontend. Moving the declaration to
the api would invert that dependency for no gain.

*Alternative rejected — type the wire value as `string` and validate only against
registration.* This makes the contract silent about a fact it is the right place
to state, costs the frontend its union type, and turns a 400 with a named
allowed-set into a generic rejection. The problem is not that the contract
enumerates; it is that four things enumerate independently.

### D2 — Reconciliation is compile-time, via a total `Record` at the composition point

The production wiring becomes
`Readonly<Record<RuntimeId, AgentRuntime>>` and the registry is built from its
values. Declaring an id without registering an implementation stops the build.

This is the third use of the repository's established shape —
`SANDBOX_PROVIDER_CAPABILITY_CLASSES` in `enforce-provider-contract-parity`, and
`ADMISSION_MODE_BY_OUTCOME` in `isolate-legacy-admission-behind-capability-policy`.
The compiler, not a reviewer, notices the gap.

*Alternative rejected — a boot-time assertion that the registry's ids equal the
declaration.* It fails in the deployment rather than in the pull request, and a
check that only runs when the app starts is a check the person adding a runtime
does not see while adding it.

*Alternative rejected — keep the array and add a runtime test comparing
`RuntimeSchema.options` to `registry.ids()`.* Better than nothing and worth having
as a supplement, but a test proves today's wiring agrees; the `Record` makes
disagreement unrepresentable. The change should do the second and may also do the
first.

### D3 — `RuntimeId` derives; it is not re-declared in the api

`agent-runtime.port.ts` stops hand-writing the union and takes it from the
contract. `isRegistered`'s docstring then describes what the code does.

The api keeps its own *name* (`RuntimeId`) for it, because the api's vocabulary
for "the thing the registry keys by" is worth keeping legible at its use sites;
what it must not keep is its own *definition*.

### D4 — One default, not two

`DEFAULT_RUNTIME_ID` derives from `DEFAULT_TASK_RUNTIME` rather than being an
independent literal that `satisfies` a separate union. Two spellings of one
default is the same defect at smaller scale, and it is in the blast radius
already.

### D5 — The guard is proven, not asserted

A `.typecheck.ts` fixture shows that a registration map missing a declared id
fails to compile, following the convention established in
`surface-parity/parity.typecheck.ts` and reused in
`admission-mode-policy.typecheck.ts`. The fixture must self-invalidate: if the map
is later weakened to a partial or string-indexed shape, the `@ts-expect-error`
directives become unused and the ordinary typecheck fails.

Verification also includes the honest end-to-end question — *what does adding a
third runtime actually cost now?* — answered by attempting it against the compiler
and recording every file the compiler demands. If that list is longer than the
declaration plus the registration, the change has not finished its job.

## Risks / Trade-offs

- **[`z.enum` and a `readonly` tuple]** → zod is `^3.23.8`; `SANDBOX_PROVIDER_FAMILIES`
  is already spread into `z.enum([...FAMILIES, 'unknown'])`, so the working spelling
  exists in-repo and is copied rather than invented.

- **[Widening `RuntimeId` silently weakens a narrowing somewhere]** → The union's
  membership does not change in this change: the same two ids are declared. Only
  the *number of places declaring them* changes, so no narrowing loses precision.
  The zero-exhaustive-switch measurement is what makes this safe to assert.

- **[The total `Record` forces every runtime to be constructed eagerly]** → It
  already is: the production wiring constructs both runtimes as a field
  initialiser today. The shape changes, the construction cost does not.

- **[Scope creep into the provider axis]** → Explicitly a Non-Goal. Recorded so
  the asymmetry is not forgotten: `ConfiguredSandboxProviderFamily` in
  `@cap/sandbox` lists `auto`/`control-plane` and omits `cloud-http`, which is the
  same defect class on the axis that is *not* blocking a locked invariant.

## Migration Plan

None. No environment variable, database, or wire-format change; the same values
are accepted and rejected before and after. Rollback is a revert.

## Open Questions

None blocking. Whether a third runtime should be operator-configurable rather than
source-declared is a real question, deferred as a Non-Goal because nothing today
needs it and answering it needs a deployment story this change does not have.
