## Context

`sandbox-provider-port` states three shared-contract rules for the provider
axis — conformance covers every provider family, a provider must not advertise a
capability that does not pass its conformance scenario, and the capability
vocabulary distinguishes provider features from CAP operations. All three are
prose. Nothing executes any of them, and all three have drifted (see
`research-brief.md` for the verified detail behind each claim below).

This is the same failure mode `fail-loud-on-unknown-runtime` just closed on the
runtime axis: the rule was written, the grep it asked for was never run, and the
code diverged in exactly the places the requirement names. The remedy that
worked there — derive rather than repeat, make the classification total so an
addition is a compile error, enforce mechanically instead of by review — applies
here with one important difference: **capability strings are an operator-facing
interface**, so this axis carries a compatibility constraint the runtime axis did
not.

Constraints:

- `BOXLITE_CAPABILITIES` is a documented `.env` variable
  (`packages/sandbox-provider-boxlite/README.md:72`) carrying a comma-separated
  capability list. A live deployment may already contain the deprecated
  `lifecycle.readoption` spelling. Breaking it would break self-hosters on
  upgrade.
- No Prisma model carries a capability or provider-family column, so there is no
  data migration.
- A third provider is an explicit goal, so "adding a provider" is the scenario
  every decision here is judged against.

## Goals / Non-Goals

**Goals**

- One capability, one internal spelling; the deprecated one survives only as a
  boundary-level input alias, normalised in exactly one place.
- Capability classification is TOTAL — a capability that exists but is
  unclassified does not compile.
- Provider identity has ONE declaration; every schema and every decision point
  derives from it, so adding a provider is a compile error at each site that
  must decide something, not a hunt.
- Required conformance families are derived from what a provider DECLARES, so
  advertising an unexercised capability fails.
- An executable gate in CI, in the shape the runtime axis established:
  reviewable data, self-testing, beside the existing two gates.

**Non-Goals**

- Adding a third provider. This change makes adding one safe; it does not add
  one.
- Changing what any capability MEANS, or any provider's declared set. Every
  provider's effective capabilities must be identical before and after.
- Rewriting the conformance scenarios themselves. Their content is out of scope;
  only which of them a provider is REQUIRED to run changes.
- Touching the runtime axis. `RuntimeId` and `Runtime` were just handled.

## Decisions

### D1 — `lifecycle.readopt` is canonical; `lifecycle.readoption` survives only as a boundary alias

`readopt` wins on evidence rather than taste: 96 references against 23; it is
what `SANDBOX_PROVIDER_CAPABILITIES` (the default-advertised list) carries; and
it is what both cloud-http and AIO actually declare. Choosing `readoption` would
mean rewriting the declarations of every shipped provider.

*Alternative considered — keep both, formalise the alias.* Rejected: that is
what the code does today, and the cost is visible — the same reconciliation
copied into two live packages plus a test that re-implements it, and the two
spellings landing on opposite sides of the operation/feature partition. An alias that must be honoured at every
comparison site is not a compatibility shim, it is a second vocabulary.

*Alternative considered — delete `readoption` outright.* Rejected on the
`BOXLITE_CAPABILITIES` constraint: an operator may have it in `.env` today, and
a silent capability drop degrades a deployment rather than failing it.

The shape: normalise at the configuration parse boundary, canonical everywhere
inside, and delete the live internal reconciliations. The alias table is DATA
in one place, not a branch repeated at each comparison.

### D2 — Classification is a total mapping; the lists derive from it

Replace the two hand-maintained lists (and their concatenation, and the
hand-written literal in `sandbox-core.test.mjs` that pins them) with a single
`Record<SandboxProviderCapability, CapabilityClass>` where `CapabilityClass`
distinguishes the operation-level default set from the opt-in feature set. Both
exported lists become derivations of that mapping.

This makes the spec's L94 partition real: today a capability can be in neither
list (the type system blesses it, `boxlite-config.ts:545` calls it unknown, and
the suite stays green), or — as `readopt`/`readoption` proves — effectively in
both. With a total mapping, neither is expressible.

*Alternative considered — derive the union FROM the lists* (`typeof LIST[number]`).
Simpler, and it also forces classification. Rejected because the union is where
the capabilities are documented — several members carry explanatory comments
that justify their existence — and folding it into two literal arrays would
scatter that. Keeping the union as the declaration site and the mapping as the
obligation preserves the documentation and matches the pattern just established
on the runtime axis.

### D3 — Provider identity is declared once; schemas and decisions derive

One `PROVIDER_FAMILIES` declaration is the source. The environment schema
derives from it directly. The diagnostics schema derives as
`[...PROVIDER_FAMILIES, 'unknown']` — the extra member is legitimate and stays:
production emits `providerFamily: 'unknown'` for an attempt that failed before a
provider was selected (`task-provisioning-diagnostics.service.ts:351`), so it is
a diagnostic-only widening, not drift. Expressing it as an explicit extension of
the shared source states that, where a fourth hand-written enum hid it.

The hand-written exhaustiveness check at
`runtime-model-environment.resolver.ts:403` becomes a total mapping, for the same
reason the runtime axis converted its equivalents: a boolean chain silently
admits a wrong answer for a new member, a total mapping does not compile.

**Carried into implementation, not decided here:** the two api-side enums
(`claude-model-capability-evidence.ts:12`,
`claude-model-capability-manifest.ts:38`) list `['aio', 'boxlite']` and omit
`cloud-http`. Whether that is a deliberate subset (these seams may genuinely not
apply to a control-plane HTTP provider) or drift cannot be settled from the
code — both readings fit. It MUST be resolved by reading the model-capability
seam before either enum is rederived: if deliberate, it becomes an explicit
subset of the shared source with the reason stated; if not, it is drift and
takes the full list. Guessing either way would be a behaviour change disguised
as a refactor.

### D4 — Required conformance families are derived from declared capabilities

A mapping from capability to the conformance family that exercises it, plus one
entry point that takes a provider and its declared capabilities and runs exactly
the required families — failing if a declared capability maps to a family that
was not run.

This implements L182 as a mechanism rather than a sentence, and it preserves
every current outcome: AIO and cloud-http declare no `command.exec`, so they are
not asked for command-output conformance; BoxLite declares it and is.

*Alternative considered — require every provider to run every family.* Rejected:
it would demand command-output conformance from providers that do not claim
command execution, which is not a real obligation and would be worked around
within a week — and a worked-around gate is no gate.

*Alternative considered — a grep-based CI gate over the provider test files.*
Rejected as the PRIMARY mechanism: a gate that checks test files for the right
function calls verifies spelling, not participation. A shared entry point makes
partial participation unexpressible instead of detectable. A gate is still added
(D5), but for the vocabulary and identity invariants a type cannot carry.

### D5 — The gate covers what types cannot

The type system will carry D2 and most of D3. Two things it cannot carry: that
no NEW duplicate-spelling pair is introduced, and that the conformance entry
point is actually the one every provider test calls. Those go in an executable
check built like `agent-identity-branch-check.mjs` — explicit reviewable list,
self-testing, wired into CI beside the discovery and agent-identity gates.

## Risks / Trade-offs

- **[An operator's `.env` carries `lifecycle.readoption` and normalisation
  misses a path]** → The alias is applied at the single parse boundary and
  covered by a test that feeds the deprecated spelling through configuration and
  asserts the provider's effective capability set is identical to the canonical
  spelling's. The README documents the deprecation without removing the input.
- **[Deriving schemas from one source changes a wire contract]** → The derived
  enums must produce byte-identical member SETS. Order differs today between the
  two contracts enums, so any test asserting member ORDER rather than membership
  will fail; that is a test-shape problem, not a contract change, and must be
  fixed by comparing sets. Any genuine membership change is out of scope and
  must be rejected.
- **[The `['aio','boxlite']` question is answered by guessing]** → Explicitly
  blocked in D3: resolve by reading the seam, and if it cannot be resolved,
  leave those two enums untouched and record why rather than rederiving them
  wrongly. A partial change here is better than a confident wrong one.
- **[The conformance entry point makes participation look mandatory while a
  provider quietly bypasses it]** → The gate (D5) exists for exactly this; and
  the entry point fails on a declared-but-unexercised capability, so bypassing it
  requires removing the call, which the gate sees.
- **[Editing dead code by mistake]** → `pnpm-workspace.yaml` excludes four
  `packages/*` directories (`sandbox-scheduler`, `sandbox-aio-local`,
  `sandbox-lifecycle`, `sandbox-workspace-git`); they are never built and have
  zero importers. One of them carries a copy of the alias reconciliation. This
  change deliberately does NOT touch them: editing a package that is not in the
  build creates the impression it is maintained, and their removal is its own
  decision. Verified during implementation after turbo rejected a `--filter` on
  one of them.

- **[Total mapping churn]** → Converting the lists touches every consumer of
  `SANDBOX_PROVIDER_CAPABILITIES` / `_FEATURE_` / `_KNOWN_`. The mitigation is
  that they stay exported with the same names and types; only their definition
  moves. Consumers should not need edits, and any that do indicate a real
  coupling worth seeing.

## Migration Plan

No data migration; no deployment step. The only externally visible surface is
`BOXLITE_CAPABILITIES`, which continues to accept both spellings.

Order of work: the vocabulary (D1, D2) first, since the conformance mapping in
D4 is keyed on capabilities and should be written against the canonical set;
provider identity (D3) is independent and can proceed in parallel; the gate (D5)
is wired last, after the violations it will find are gone — the same sequencing
the runtime axis used, so CI is never knowingly red.

Rollback is a revert: nothing is persisted, and no operator input becomes
invalid.

## Open Questions

- Are the api-side `['aio', 'boxlite']` enums a deliberate subset or drift? D3
  blocks on reading the model-capability seam rather than guessing. This is the
  one question that could reduce the change's scope, and it must be answered
  during implementation, not assumed at either end.
- Does any conformance family exercise a capability only INDIRECTLY — as
  workspace-git conformance does today, running against the shared staged
  helpers rather than a provider? If so the capability→family mapping needs a
  way to say "covered by the shared helper suite", and that has to be an
  explicit, stated entry rather than an omission that reads as coverage.
