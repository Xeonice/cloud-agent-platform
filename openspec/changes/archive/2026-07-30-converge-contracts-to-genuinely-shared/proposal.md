## Why

`packages/contracts` is the one package an api and a web console both depend on,
and the repo-split epic is about to make it a published npm package. Before that
happens it should be true that everything in it is shared and everything shared
is in it. Neither half holds today.

An audit of every contract symbol a consumer re-declares locally — 24 candidates,
each adjudicated against both declarations, with the verdicts that could hide a
duplicate attacked by two independent refuters — returned:

```
DUPLICATE   13   ← a local copy of a shared type, existing for no stated reason
DERIVED      5   ← an alias or narrowing, not an independent restatement
DIVERGENT    4   ← same concept, deliberately different
COLLISION    1   ← unrelated concept, colliding name
```

None of the 13 causes a failure today. Two have already drifted, and neither is
noticed because nothing executes the schema that would notice:

```
contract  SmtpConfigReadSchema   host/user/from .min(1) · port .min(1)
api sends { host:'', port:0, user:'', from:'', … }        smtp.controller.ts:259
          — the api emits a body its own declared contract would reject, and
            SmtpConfigReadSchema has zero call sites anywhere in the repository

contract  RuntimeReadinessResponseSchema = z.array(…)
api sends { runtimes: [...] }                             runtimes.service.ts:83
          — the console carries defensive code for the mismatch (real.ts:776)
```

The rest are lost compile-time signal rather than bugs. That is precisely why
this belongs before the split rather than after: **the epic's next phase builds a
version-skew gate, and a gate is only as good as the declarations it reads. Three
of the six dead contract exports are dead because a consumer re-declared them,
and a schema nobody executes silently becomes false.**

## What Changes

- **The 13 duplicates converge on the contract.** Ten are a one-line import — the
  package already depends on `@cap-console/contracts`. Three are in
  `packages/sandbox-environment`, which deliberately depends only on
  `@cap-console/sandbox-core`; all three are used in type position only, so they
  converge through a type-only import that leaves the runtime dependency graph
  untouched.
- **The sandbox vocabularies converge by type and are reconciled by gate at
  runtime** (epic D14). `sandbox-core` keeps its own value-level list because it
  needs it at runtime and must stay dependency-free; a parity check asserts the
  two agree, in the shape `provider-contract-parity-check.mjs` already uses.
- **Stale scaffolding goes.** Three DERIVED aliases are expired, and the COLLISION
  case's contract-side alias pair is dead code.
- **Reachability is re-measured afterwards, and only then are dead modules
  removed.** Deleting first would legitimise the duplication that killed them.
- **A gate makes the property hold.** An export in `packages/contracts` that no
  consumer imports fails the build. That rule is the literal statement of
  "everything in contracts is genuinely shared", and every existing gate missed
  at least one of these pairs.

Not breaking: no HTTP, MCP, database, or environment-variable surface changes. The
wire shapes are unchanged — this converges the *declarations* of shapes that are
already being sent.

## Capabilities

### Modified Capabilities

- `monorepo-foundation`: the "contracts package is the single source of truth"
  requirement gains the half that makes it checkable — a shared type may not be
  restated by a consumer, and an export nothing imports is not shared.

## Impact

**Code** — as landed, which is more than this was scoped for in two places and
less in one:

- 14 local declarations converged, not 13. The fourteenth is
  `apps/api/src/mail/smtp-config.service.ts`'s own `SmtpConfigRead`, which
  carried the comment "Mirrors `@cap-console/contracts` `SmtpConfigRead`" and was
  found by re-running the audit scan in task 4.5 rather than by the original.
- 10 exports deleted, not "three aliases and one pair": the four unprefixed
  `Provisioning*` alias pairs in `task.ts` and `terminal-recording-internal.ts`
  in full. One of the three expected DERIVED aliases, `sandboxProviderLabel`, had
  nothing to delete — it is a different function that shares a name.
- `packages/sandbox-core` gains type-only imports.
- **Two** new gates, not one: `test:vocabulary-parity` (ten sandbox vocabularies
  that must exist twice) and `test:contracts-shared` (the export-reachability
  gate this change's Why argues for).
- Two behaviour changes, both in Track 3 and each with its own decision recorded:
  `GET /settings/smtp` now conforms to a relaxed read schema, and `GET /runtimes`
  now returns the bare array its contract always declared instead of an envelope.

**Deliberately not done, and why** — 14 further contract exports are unreachable
and none was deleted. Each is either restated by consumers as an inline literal
(`'Bearer'` at ~30 sites; `startsWithReservedPrefix` reimplemented inside a test)
or a declaration nothing executes. Deleting the first class would ratify the
duplication, which design D3 forbids; deleting the second would discard a stated
rule, which is the mistake that produced this change. They are recorded as gate
exceptions with per-item reasons and are the seed of a follow-up.

**Not in scope, and why** — publishing (`private`, version, `zod` as a
peerDependency, release-please multi-package) is the epic's Phase 1c. It is a
separate change because it turns on a question this one does not need answered:
what a contracts version means relative to the platform version the umbrella tag
carries (epic D5).

**Verification** — a converged symbol must change behaviour nowhere. The two
already-drifted pairs are the exception: converging them makes the api's SMTP
response and the `/runtimes` envelope conform to declarations that currently
contradict them, and that is a real change requiring its own evidence.

**Non-Goals**

1. Publishing anything, or any repository restructuring.
2. Resolving the 4 DIVERGENT cases. They are genuine disagreements between the
   two sides and are inputs to the skew gate, not defects to converge away.
3. Making the console tolerant of unknown enum members. That the console runs
   closed-enum `.parse()` on responses — so any api vocabulary addition is today
   a breaking change — is a real finding, and it belongs to the phase that defines
   compatibility.
