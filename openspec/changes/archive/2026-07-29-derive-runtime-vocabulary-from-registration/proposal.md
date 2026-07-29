## Why

Adding a third agent runtime — OpenCode, PI Agent — is a locked goal of this
programme. The code physically prevents it, while its own comments claim it does
not.

"Which runtimes exist" is stated four times, in four places, with nothing
reconciling them:

| where | form | claims to be |
|---|---|---|
| `packages/contracts/src/task.ts:61` | `z.enum(['claude-code','codex'])` | the API-boundary authority |
| `apps/api/src/agent-runtime/agent-runtime.port.ts:37` | `type RuntimeId = 'codex' \| 'claude-code'` | the type the registry keys by |
| `AgentRuntimeRegistry.byId` | actual registrations | *"the answer comes from what is REGISTERED"* |
| `apps/web/src/lib/api/real.ts:155` | `type RuntimeId = "claude-code" \| "codex"` | the console's own copy |

The fourth is the sharpest: the console **already depends on `@cap/contracts`**
and re-declares the set anyway.

The registry's own docstring says "registering a third runtime needs no edit
here". Three lines below it, `isRegistered(value): value is RuntimeId` narrows to
the hand-written union above — so a third runtime cannot even be *held* without
editing that union. The contract enum then rejects it at the HTTP boundary before
the registry is ever consulted, including on `GET /runtimes`, the endpoint whose
entire job is to publish which runtimes exist. **The discovery mechanism validates
its own response against a frozen list of what may be discovered.**

The contract file is honest about the arrangement: it says the enum is "kept
byte-for-byte in sync with the values the api runtime registry resolves by". That
sync is a sentence in a comment. A grep for anything that checks it returns
nothing.

The neighbouring axis already solved this. `SANDBOX_PROVIDER_FAMILIES` is a single
`as const` declaration, and `TaskProvisioningDiagnosticProviderFamilySchema`
derives from it with an explicit `'unknown'` extension point. The runtime axis was
simply never converted, so the two axes are not symmetric and only one of them
admits a third implementation.

## What Changes

- **One declaration replaces four.** The runtime vocabulary becomes a single
  exported `as const` list in `@cap/contracts`, mirroring
  `SANDBOX_PROVIDER_FAMILIES`. The request/response schema and the api's
  `RuntimeId` both derive from it, so the union and the validator cannot disagree
  because there is only one of them.
- **The comment becomes a check.** Registration and declaration are reconciled by
  something that fails — a declared runtime with no registration, or a
  registration outside the declaration, stops the build or fails at boot rather
  than being caught by a reader.
- **Adding a runtime becomes two edits with no third.** One line in the
  declaration, one registration. Anything else that must change is a defect this
  change is meant to expose.
- **Behaviour is unchanged.** The same two runtimes are accepted, the same values
  are rejected, `GET /runtimes` returns the same shape, and the persisted column
  (already `String?`, unconstrained) is untouched.

Not breaking: no HTTP, MCP, database, or environment-variable surface changes.

## Capabilities

### New Capabilities

None. This is the existing `agent-runtime` capability's own extension promise
being made true; naming it separately would split one story across two specs.

### Modified Capabilities

- `agent-runtime`: the set of runtime identifiers becomes a single declaration
  that registration is checked against, rather than four independent statements
  reconciled by a comment. Admitting a third runtime is required to need no edit
  outside that declaration and its registration.

## Impact

**Code**

- `packages/contracts/src/task.ts` — `RuntimeSchema` derives from the new
  declaration. Consumed at 8 further positions across `task`, `schedule`,
  `runtime.ts`, `runtime-model`, and `public-v1-operations`; all follow the
  declaration rather than being edited individually.
- `apps/api/src/agent-runtime/agent-runtime.port.ts` — the hand-written
  `RuntimeId` union is replaced by the derived type.
- `apps/api/src/agent-runtime/agent-runtime.registry.ts` — `isRegistered` keeps
  its registration-derived semantics, which become true rather than aspirational.
- `apps/api/src/sandbox/prisma-provision-lookup.ts` — two `RuntimeSchema` parses,
  unchanged in meaning.
- `apps/web/src/lib/api/real.ts` — the console's re-declared union derives from
  the contract it already depends on.
- A reconciliation check, mounted where the existing gates are, so it runs rather
  than sitting unrun.

**Measured, not assumed** (`baseline.md` §3) — admitting a third runtime today
costs edits to four vocabulary statements plus six per-runtime policy tables, and
**registering an implementation is not checked at all**: the project compiles with
a declared-but-unregistered runtime and fails at task launch. The six policy
tables are correct as they are and stay.

**Evidence in hand** — the persisted column is `String?` with no DB constraint;
the console reads the runtime list from `GET /runtimes` at runtime rather than
from a compiled-in list; and there are **zero** exhaustive `switch` sites on the
`Runtime` union, so widening it costs no existing type safety.

**Not affected** — no active change touches `agent-runtime` or
`packages/contracts/src/task.ts`.

**Non-Goals** (each deliberately deferred so it can be judged on its own evidence):

1. Implementing OpenCode, PI Agent, or any third runtime. This change makes one
   admissible; it does not add one.
2. Reconciling the *provider* axis's second vocabulary
   (`ConfiguredSandboxProviderFamily` in `@cap/sandbox` lists `auto` and
   `control-plane` and omits `cloud-http`). Same defect class, different axis, and
   it does not block a locked invariant.
3. Changing what a runtime *is* — the `AgentRuntime` policy/mechanism split, its
   capability declarations, and the model-selection contract are untouched.
4. Making the runtime set operator-configurable at deployment time. The
   declaration stays a source-level fact.
