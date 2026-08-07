## ADDED Requirements

### Requirement: The tasks-guardrails composition edge carries no forwardRef, and a gate says so

`apps/api/src/tasks/tasks.module.ts` SHALL import `GuardrailsModule` directly, and neither it nor
`apps/api/src/guardrails/guardrails.module.ts` SHALL contain a `forwardRef(` naming the other. The
cycle those two once formed is ALREADY GONE — `guardrails.module.ts` declares `imports: []`, and no
non-test file under `apps/api/src/guardrails/` imports `@/tasks` — so what remains at
`tasks.module.ts:58` is a vestige of a dependency that no longer exists. Three sibling modules
(metrics, settings, terminal) already import `GuardrailsModule` plainly, which is the precedent.

A vestigial `forwardRef` is not inert. It reads as evidence that a cycle exists, so the next author
who needs to move either module budgets for breaking one that was broken years of commits ago, and
the next author who introduces a real cycle finds the tool that would have flagged it already present
and assumes it was deliberate.

The absence SHALL be enforced by a gate, because the gate the repository already has cannot see this
edge. `monorepo-foundation`'s acyclic requirement exempts imports made BY a `*.module.ts` file, and
that exemption is deliberate and stays — a framework whose composition model requires such imports
would otherwise be satisfied by indirection that hides the same cycle. But the exemption means a
`forwardRef` between two module files is invisible to it BY CONSTRUCTION, not by oversight. The gate
this requirement adds is therefore narrow on purpose: it reads exactly these two files, and it does
not attempt to re-litigate the exemption.

The gate SHALL fail closed in both directions. A `forwardRef` appearing between the two files fails
it; so does the gate losing its subject — if either file is renamed or moved away from the path the
gate reads, the gate SHALL fail rather than silently pass over a file that is no longer there. A
check that passes because it found nothing to check is the failure mode this repository has paid for
before.

The gate SHALL carry its own self-test, registered the way every other narrow check in `scripts/` is:
a `*-check.mjs` beside a `*-check.test.mjs`, wired to one `package.json` script that runs both.

#### Scenario: The vestigial forwardRef is gone and the import is plain

- **WHEN** `apps/api/src/tasks/tasks.module.ts` is read
- **THEN** it imports `GuardrailsModule` directly, `forwardRef` is not imported from `@nestjs/common`,
  and the paragraph that explained the import as breaking a circular reference no longer says so —
  because it does not

#### Scenario: A reintroduced forwardRef fails the gate

- **WHEN** a `forwardRef(` naming the other module is added to either file
- **THEN** the gate exits non-zero and names the file and the direction

#### Scenario: The gate fails when it loses its subject

- **WHEN** either file is absent from the path the gate reads
- **THEN** the gate exits non-zero rather than reporting success over a file it never opened

#### Scenario: The gate is registered like every other narrow check

- **WHEN** the repository's narrow checks are enumerated
- **THEN** this one has a `scripts/*-check.mjs`, a `scripts/*-check.test.mjs` beside it, and a single
  `package.json` script that runs the check and then its self-test
