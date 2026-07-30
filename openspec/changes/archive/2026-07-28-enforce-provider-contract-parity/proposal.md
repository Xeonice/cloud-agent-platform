## Why

`sandbox-provider-port` already requires that conformance verify **every**
provider family (L170), that a provider **not advertise a capability that does
not pass its conformance scenario** (L182), and that the capability vocabulary
distinguish provider features from CAP operations (L94). None of the three is
mechanically enforced, and all three have drifted:

- the same capability exists under **two spellings** — `lifecycle.readopt` and
  `lifecycle.readoption` — which landed on **opposite sides** of the very
  operation/feature partition the spec calls meaningful, and a bidirectional
  alias reconciliation papering over that is copy-pasted into **three packages**;
- the capability vocabulary is written out **four times** (union, two
  classification lists, their concatenation) with **nothing reconciling them** —
  no `satisfies`, no total mapping, only a `deepEqual` against a hand-written
  fifth copy in a test;
- provider identity is hardcoded in **four independent enums whose contents
  disagree** (two omit `cloud-http` entirely; the member order differs between
  the other two);
- conformance participation is **voluntary** — each provider's test picks which
  scenario families to invoke, with no link to what that provider declares.
  (Today's picks are defensible: AIO and cloud-http skip command-output
  conformance and neither declares `command.exec`. The problem is that nothing
  checks that they are defensible, so the arrangement is one edit away from a
  provider advertising a capability nothing exercises — which is precisely what
  L182 forbids.)

This is the provider-axis twin of the runtime-axis problem just closed by
`fail-loud-on-unknown-runtime`: a written shared contract that nothing executes,
where every divergence fails quietly. It matters now because a third provider is
an explicit goal, and today adding one means finding four enums by hand,
classifying a capability into lists nothing checks, and passing a "conformance"
suite whose hard third is optional.

## What Changes

- **One spelling for one capability.** `lifecycle.readopt` becomes canonical;
  `lifecycle.readoption` is removed from the internal vocabulary and the three
  duplicated alias reconciliations are deleted. **Not breaking for operators**:
  `BOXLITE_CAPABILITIES` is a documented `.env` interface that may already carry
  the deprecated spelling, so it stays ACCEPTED at the configuration boundary,
  normalised once at parse time instead of reconciled forever internally.
- **The vocabulary is derived, not repeated.** The classification lists become
  the single source and the union derives from them (or an equivalent total
  mapping), so a capability that exists but is unclassified is a compile error
  rather than a value the type system blesses and the runtime calls unknown.
  The hand-written literal in `sandbox-core.test.mjs` stops being a fifth copy.
- **One source for provider identity.** The provider-family list is declared
  once and the schemas derive from it. The diagnostics schema's extra `unknown`
  member is either justified as a diagnostic-only widening expressed as such, or
  removed as drift. The hand-written `family === 'aio' || …` exhaustiveness
  check becomes a total mapping.
- **Conformance participation becomes mechanical, keyed on what the provider
  declares.** Required scenario families are derived from the provider's own
  declared capabilities rather than chosen by whoever writes its test, so
  declaring a capability whose family is not exercised FAILS. This implements
  L182 as a mechanism instead of a sentence. It also preserves today's correct
  outcomes — AIO and cloud-http do not declare `command.exec`, so they are not
  asked for command-output conformance.
- **An executable check**, in the shape that worked for the runtime axis: it
  carries its list as reviewable data, self-tests so it is provably able to
  fail, and runs in CI beside the discovery and agent-identity gates.

## Capabilities

### New Capabilities

_None._ This change enforces contracts that `sandbox-provider-port` already
states; it does not introduce a new capability area.

### Modified Capabilities

- `sandbox-provider-port`: the capability-vocabulary requirement gains the
  reconciliation obligation (one spelling per capability; classification total
  and derived, so an unclassified capability cannot compile); the conformance
  requirement gains mandatory participation (the required scenario families are
  enumerated and a provider that skips one fails); and provider identity gains a
  single-source obligation so adding a provider is a compile error at each site
  that must decide something for it, rather than a hunt across four enums.

## Impact

- `packages/sandbox-core/src/capabilities.ts` — the vocabulary and its
  classification lists; the origin alias reconciliation
- `packages/sandbox-scheduler/src/scheduler.ts`, `packages/sandbox-conformance/src/conformance.ts` — the two copied alias reconciliations
- `packages/contracts/src/sandbox-environment.ts`, `packages/contracts/src/task-provisioning-diagnostics.ts` — the two provider-family enums
- `apps/api/src/runtime-models/` — `claude-model-capability-evidence.ts`,
  `claude-model-capability-manifest.ts` (two more enums, both omitting
  `cloud-http`), `runtime-model-environment.resolver.ts` (hand-written
  exhaustiveness)
- `packages/sandbox-provider-boxlite/src/boxlite-config.ts` — the env parse
  boundary that must keep accepting the deprecated spelling, and its README
- the three provider test entry points that select conformance families
- `scripts/` + `.github/workflows/ci.yml` — the new gate, beside the existing two
- **No database impact**: no Prisma model carries a capability or
  provider-family column.
- **No operator-facing breaking change**, provided the deprecated
  `BOXLITE_CAPABILITIES` spelling keeps parsing. That constraint is the reason
  the fix normalises at the boundary rather than deleting the string.
