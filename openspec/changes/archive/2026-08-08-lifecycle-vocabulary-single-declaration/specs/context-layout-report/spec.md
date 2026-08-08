## ADDED Requirements

### Requirement: The Prisma-placement check exempts DI composition, declared and narrow

The Prisma-placement check SHALL exempt files the manifest classifies as the `composition` pseudo-layer,
and that exemption SHALL be declared in the manifest rather than encoded in the script.

The reason is that the alternative is not achievable by writing code. Three findings today are Nest
`useFactory` providers in `*.module.ts` files — `guardrails.module.ts`, `sandbox.module.ts`,
`runtime-models.module.ts` — which hand a `PrismaService` to something they construct. A composition
root that wires a database client is the framework's assembly model, not a layering violation: moving
it produces indirection that hides the same wiring rather than removing it. Leaving the findings in
place instead means a burn-down target that provably cannot reach zero, and a target known to be
unreachable stops being read as a target.

The exemption SHALL be symmetric with the one `crossContextRules` already declares for the same
pseudo-layer, and SHALL be as narrow: it is about the IMPORTING file being composition, not about the
directory it sits in and not about what it constructs.

Measured by simulate-then-measure at propose time and CONFIRMED on the integrated tree: with the
exemption in place `node scripts/context-layout-check-v2.mjs` reports `prisma-outside-store` 59 → 56 —
exactly the three module files and no others — while the remaining three classes are unchanged. The predicate SHALL be the SAME
`isComposition` the cross-context rule already computes, so the two exemptions cannot drift apart; that
predicate also admits the two declared composition roots (`main.ts`, `app.module.ts`), and the
measurement above shows neither carries a Prisma reference today — so the exemption's reach is three,
not three-plus-whatever-those-two-do-later. If either later acquires one, it is covered, and that is a
consequence of the symmetry rather than an oversight.

Widening it SHALL require an adjudication in a change, the same way the manifest's own `$comment`
binds every rule edit to one. An exemption is a hole with a reason attached; a hole whose reason
nobody wrote down is indistinguishable from an oversight, and the next author will treat it as one.

#### Scenario: A composition file wiring Prisma is not a placement violation

- **WHEN** a `*.module.ts` file classified as `composition` references `PrismaService` or
  `@prisma/client`, and the layout v2 script runs
- **THEN** it is not reported as a Prisma-placement violation

#### Scenario: The exemption lives in the manifest, not the script

- **WHEN** the repository is searched for what the Prisma-placement check exempts
- **THEN** the answer is in `docs/refactor/contexts-manifest.json`, and the script reads it rather than
  carrying a second copy — the same single-declaration discipline the classification rules already keep

#### Scenario: A non-composition file gets no cover from this exemption

- **WHEN** an ordinary application or interface file references Prisma outside a `*.store.ts`
- **THEN** it is still reported, because the exemption is keyed on the importing file's classification
  and nothing else

#### Scenario: The baseline shrinks in the same commit as the exemption

- **WHEN** the exemption lands
- **THEN** the ratchet baseline entries it retires are removed in that commit, because the comparator
  treats a measurement BELOW its baseline as a failure exactly as it treats one above

### Requirement: The domain layer is nameable by a declared suffix, and naming it shrinks the unclassified class

The manifest SHALL declare a file→layer rule under which a pure-domain file classifies as `domain`,
and the file this change moves into that layer SHALL leave the unclassified class rather than merely
change which class reports it.

The rule form is FORCED by the interpreter, not chosen. `classifyLayer`
(`scripts/context-layout-check-v2.mjs:262-268`) matches with `probe.endsWith(rule.suffix)` over the
path — so a suffix MAY span a path-segment boundary, which the existing `/main.ts` rule proves, but it
still anchors at the END of the path. "Every file beneath a `domain/` directory" is therefore NOT
expressible. Teaching the interpreter a directory rule would change the classification MECHANISM that
`context-layout-report`'s existing declared-once-and-fails-closed requirement governs, and this change
deliberately does not touch it: adding a row to the rule table is data, adding a rule KIND is not.

The cost of that degradation SHALL be stated rather than absorbed: every later phase-5 cut that creates
a pure-domain file must adopt the declared suffix in the file's NAME, and a file that forgets it is
reported as unclassified rather than silently accepted. That is the intended failure — it is loud, and
it is the reason this rule is a technical precondition for the cuts that follow rather than tidying.

Measured by simulate-then-measure at propose time and CONFIRMED on the integrated tree:
`unclassified-file` falls 129 → 128 while `cross-context-import` holds at 129 and `layer-direction` at
2 (`prisma-outside-store` reads 56 there, moved by the composition exemption in the requirement above
rather than by this rule). Naming the
layer must not buy a reduction in one class by creating a finding in another; that it does not is
measured here rather than argued.

#### Scenario: A pure-domain file classifies as domain

- **WHEN** the layout v2 check classifies a file that carries the declared domain suffix
- **THEN** its layer is `domain`, and it produces no `unclassified-file` finding

#### Scenario: The unclassified class shrinks and nothing else moves

- **WHEN** the check is run after the rule lands
- **THEN** `unclassified-file` is one lower than before and the other three finding classes are
  unchanged, so the reduction is a reclassification and not a trade

#### Scenario: The retired baseline entry is deleted in the same commit

- **WHEN** the classification rule lands
- **THEN** the `unclassified-file` baseline entry naming the reclassified file is gone from the ratchet
  in that same commit, because a baseline tolerating a finding that no longer occurs is reported as a
  stale entry and fails the gate exactly as an excess finding does

## MODIFIED Requirements

### Requirement: A layout v2 script performs three check classes from the contexts manifest

A new standalone script SHALL read `docs/refactor/contexts-manifest.json` and
report, over the manifest's declared scope, three classes of findings:
(1) cross-context imports that match none of the manifest's legal forms,
(2) layer-direction violations against the manifest's `layers.order`
(interface → application → domain/store), and (3) Prisma access
(`@prisma/client` or `PrismaService`) in files other than `*.store.ts`, outside
the exemptions the manifest declares.

⚠ This requirement is MODIFIED for one clause and one scenario. Its previous
statement named the Prisma exemption as **the shared-kernel exemption
specifically**, in both the prose and the scenario's `WHEN`. Adding the
composition exemption made that scenario FALSE about the tree — a `*.module.ts`
DI factory wiring `PrismaService` satisfies "not a `*.store.ts` and not covered
by a shared-kernel exemption" and is nonetheless not reported. Two live
requirements would then contradict each other, which is a worse outcome than the
wholesale-replacement hazard that argued for leaving this requirement alone: a
contradiction is exactly the "true in one place, false in another" failure this
epic has paid for repeatedly. All three scenarios are carried through
deliberately; only the third changes, and only in its exemption clause.

Which exemptions exist, and how narrow each is, stays declared in the manifest
and governed by the requirement that adds the composition one — this requirement
says only that the check honours what the manifest declares, not which
exemptions the manifest is allowed to hold.

#### Scenario: An illegal cross-context import is reported

- **WHEN** a governed file imports another context's internals in a form the
  manifest's crossContextRules do not allow, and the script runs
- **THEN** the report lists that import as a cross-context violation with file
  and specifier

#### Scenario: An upward layer import is reported

- **WHEN** a file classified in a lower layer imports a module classified in a
  higher layer (against `layers.order`), and the script runs
- **THEN** the report lists that import as a layer-direction violation

#### Scenario: Prisma outside the store layer is reported

- **WHEN** a governed file that is not a `*.store.ts` file and is not covered
  by any exemption the manifest declares imports `@prisma/client` or
  `PrismaService`, and the script runs
- **THEN** the report lists that file as a Prisma-placement violation
