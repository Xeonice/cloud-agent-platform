# Research brief — enforce-provider-contract-parity

Serial research pass (no fan-out). Every claim below was verified against the
working tree at commit `a6441c1`; file:line references are from that state.

## Method

Read the provider-side sources, the capability vocabulary, the conformance
package and its consumers, and the two `openspec/specs` capabilities that
already govern this area. Where a rule was already written down, the check was:
does the code do what the rule says? That is the same question the previous
change (`fail-loud-on-unknown-runtime`) turned out to hinge on, and it is the
question that produced every finding here.

## What the specs already require

`openspec/specs/sandbox-provider-port/spec.md` already carries two SHALLs that
bear directly on this work:

- L170 — *"Provider conformance SHALL verify **every provider family eligible for
  task provisioning, including AIO, cloud-http, and BoxLite**"*
- L182 — *"A provider SHALL NOT advertise a capability that does not pass its
  conformance scenario."*

and at L94, *"Capability vocabulary distinguishes provider features from CAP
operations"* — the partition that findings F1 and F2 show is not maintained.

So, as with the runtime axis, the rules exist. Nothing executes them.

## Findings

### F1 — One capability, two spellings, split across the partition that is supposed to be meaningful

`packages/sandbox-core/src/capabilities.ts` declares BOTH `lifecycle.readopt`
(L25) and `lifecycle.readoption` (L26) in the same union. They are the same
capability. The evidence that they are the same is that the codebase carries a
**bidirectional alias reconciliation** treating either spelling as satisfying a
requirement for the other — duplicated across these sites:

| Location | |
|---|---|
| `packages/sandbox-core/src/capabilities.ts:143` | the origin — LIVE |
| `packages/sandbox-conformance/src/conformance.ts:448` (and `:351`) | second copy — LIVE |
| `packages/sandbox-scheduler/src/scheduler.ts:344-345` | verbatim copy in a package that is **not in the workspace** |
| `apps/api/src/tasks/startup-recovery.test.mjs:209-210` | a TEST re-implementing the production logic |

**Correction made during implementation.** The first pass of this brief said
"copied into three packages". That overstated it: `pnpm-workspace.yaml`
explicitly EXCLUDES `packages/sandbox-scheduler` (along with
`sandbox-aio-local`, `sandbox-lifecycle`, `sandbox-workspace-git`), so turbo
knows 16 packages and that is not one of them — it is never built, typechecked
or tested, and all four excluded packages have **zero importers**. The live
duplication is therefore TWO copies plus a test that re-implements the same
rule. Still duplication worth removing; not three packages. The dead packages
are a separate finding and are deliberately left untouched by this change.

Worse than a stray alias: the two spellings land on **opposite sides of the
operation/feature partition** the spec calls meaningful —

- `lifecycle.readopt` ∈ `SANDBOX_PROVIDER_CAPABILITIES` (L42, "operation-level")
- `lifecycle.readoption` ∈ `SANDBOX_PROVIDER_FEATURE_CAPABILITIES` (L59, "feature")

The comment on the second list says providers "opt in only after implementing
and preflighting the feature". One spelling of readoption is therefore
default-advertised and the other is opt-in. The copies of the alias
reconciliation exist to paper over exactly that.

### F2 — The capability vocabulary is expressed four times with nothing reconciling them

1. the `SandboxProviderCapability` union — 17 members (L9-27)
2. `SANDBOX_PROVIDER_CAPABILITIES` — 5 members (L37)
3. `SANDBOX_PROVIDER_FEATURE_CAPABILITIES` — 12 members (L52)
4. `SANDBOX_PROVIDER_KNOWN_CAPABILITIES` — the concatenation of 2 and 3 (L66)

5 + 12 = 17 today. Nothing enforces that. `capabilities.ts` contains no
`satisfies` on the lists and no `Record<SandboxProviderCapability, …>` — grep for
both returns nothing. The only thing resembling a check is
`packages/sandbox-core/test/sandbox-core.test.mjs:48`, a `deepEqual` of KNOWN
against a hand-written literal — a FIFTH copy of the list, which pins today's
value rather than proving the union is covered.

Consequence, concretely: add a member to the union and forget to classify it,
and `boxlite-config.ts:545` (`new Set(SANDBOX_PROVIDER_KNOWN_CAPABILITIES)`)
treats it as unknown while the type system says it is a valid capability. The
suite stays green.

### F3 — Provider identity is hardcoded in at least four independent enums whose contents disagree

| Location | Contents |
|---|---|
| `packages/contracts/src/sandbox-environment.ts:17` | `['aio', 'boxlite', 'cloud-http']` |
| `packages/contracts/src/task-provisioning-diagnostics.ts:44` | `['aio', 'cloud-http', 'boxlite', 'unknown']` |
| `apps/api/src/runtime-models/claude-model-capability-evidence.ts:12` | `['aio', 'boxlite']` — **omits cloud-http** |
| `apps/api/src/runtime-models/claude-model-capability-manifest.ts:38` | `['aio', 'boxlite']` — a fourth copy |

Plus a hand-written exhaustiveness check at
`apps/api/src/runtime-models/runtime-model-environment.resolver.ts:403`:
`family === 'aio' || family === 'boxlite' || family === 'cloud-http'`.

Even the member ORDER disagrees between the first two, which is the signature of
independent hand-maintenance rather than a shared source. Adding a fourth
provider means finding all of these, and nothing points at them.

### F4 — Conformance participation is voluntary, contradicting the SHALL at L170

`packages/sandbox-conformance` exports five scenario-factory families. Each
provider's own test file chooses which to invoke:

| Provider | conformance / behavior / diagnostic | command-output |
|---|---|---|
| AIO | yes | **no** |
| BoxLite | yes | yes |
| cloud-http | yes | **no** |

`createSandboxCommandOutputConformanceScenarios` is called only from
`packages/sandbox-provider-boxlite/test/boxlite-conformance.test.mjs` (and the
conformance package's own self-test).
`createSandboxWorkspaceGitConformanceScenarios` is called only from
`packages/sandbox/test/provider-conformance.test.mjs`, which exercises the SHARED
git helpers, not a provider.

**Correction made during research — the first reading of this table overstated
it.** The obvious conclusion ("AIO and cloud-http skip command-output
conformance") is not a live violation, because **neither declares
`command.exec`**:

- AIO's declared set (`defaultAioProviderCapabilities`, `aio-provider.ts:1234`)
  is `terminal.websocket`, `workspace.git.materialize`, `workspace.source.volume`,
  `workspace.source.git`, `workspace.git.deliver`, `transcript.retained-read`,
  `lifecycle.readopt` — no `command.exec`.
- cloud-http declares three capabilities (`http-cloud-provider.ts:54`) — no
  `command.exec`.

Skipping the command-output family is therefore CORRECT for both. Today's
assignments are defensible.

The gap is that **nothing checks that they are**. Which families a provider runs
is chosen by whoever wrote its test file, with no link to what the provider
declares. The L182 SHALL — a provider must not advertise a capability that does
not pass its conformance scenario — is enforced by nobody, so today's defensible
arrangement is one edit away from not being, and no one would learn of it. The
one asymmetry visible right now is that AIO declares `workspace.git.*` while
`createSandboxWorkspaceGitConformanceScenarios` runs only against the SHARED
staged helpers (`packages/sandbox/test/provider-conformance.test.mjs`), never
against a provider — arguably adequate, since AIO's materialization hook IS
those helpers, but that is an argument nobody wrote down and nothing verifies.

## What this change should therefore be

Structurally the same treatment the runtime axis just received, applied to the
provider axis: derive rather than repeat, make classification total so an
addition is a compile error, and make participation mechanical rather than
voluntary. Specifically —

- collapse the duplicate spelling to one, deleting all three alias copies;
- derive the vocabulary lists from a single total classification, so a new
  capability cannot exist without being classified;
- give provider identity ONE source and derive the schemas from it;
- make conformance participation enumerated and enforced, so skipping a family
  is a failure rather than an omission nobody sees.

## Open questions carried into design

- Which spelling is canonical, `readopt` or `readoption`? Consumer counts favour
  `readopt` (96 references vs 23), and `openspec/specs/sandbox-readoption/`
  exists as a capability name. To be settled in design with the migration cost
  of each direction.
- ~~Does any persisted row or wire payload carry a capability string?~~
  **Answered, and it changes the shape of the fix.** No Prisma model carries a
  capability column (grep for `capab` in `schema.prisma` returns nothing), BUT
  capability strings are an **operator-facing configuration interface**:
  `BOXLITE_CAPABILITIES` is a comma-separated capability list a self-hoster puts
  in their `.env`, documented in `packages/sandbox-provider-boxlite/README.md:72`
  ("No capabilities are implied"). A deployment may therefore already have
  `lifecycle.readoption` written into its environment. So the deprecated
  spelling CANNOT simply be deleted — it has to keep being ACCEPTED at the
  configuration boundary while ceasing to exist internally. That argues for
  normalising once, at the parse boundary, and deleting the three internal
  reconciliations rather than the string itself.
- `TaskProvisioningDiagnosticProviderFamilySchema` carries an extra `unknown`
  member the others lack. Whether that is a legitimate diagnostic-only widening
  or drift needs deciding before the schemas are derived from one source.
