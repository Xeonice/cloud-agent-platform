## ADDED Requirements

### Requirement: Three collaborator groups leave the orchestrator together, each at its own measured floor

This change SHALL remove references to three collaborators in one commit series, and SHALL record a
SEPARATE floor for each rather than one headline number, because the three floors have three
different causes. The floors are: provisioning diagnostics from 8 to **4**, transcripts from 2 to
**1**, and metrics-projection from 2 to **2 — unmoved**. Every count SHALL be established by running
the dependency-budget gate's own measurement over the post-change file, never by counting deleted
lines, and never by grepping the identifier a collaborator used to have.

The metrics-projection floor is **2, the same 2 it started at**, and saying so is the point. The port
extraction renamed that collaborator's symbol; the orchestrator kept naming it exactly as often as
before. A count that falls because an identifier was renamed is a forged burn-down, and an entry
retired on that basis leaves a live coupling with nothing measuring it. What this change delivers for
that group is a change of FORM — a bare module import became a port import, which is what moves the
cross-context ratchet — not a removal.

The transcript floor is **1, not 0**, and the reason SHALL be recorded rather than left as an
unexplained shortfall: the orchestrator's transcript capture is awaited at both terminal chokepoints
BEFORE the stop-only sandbox teardown, so that the archive write happens while the container still
exists. That happens-before is carried by the awaited call itself. Removing the call would move a
correctness guarantee into an ordering the framework does not promise, so the awaited call SHALL be
retained and only the optional-reference guard beside it SHALL disappear. A change that reports this
group as burned down, or that removes the awaited call in exchange for an event, SHALL be refused.

The diagnostics floor is **4, not 2**, because the two constructor parameters survive: the
orchestrator still passes both into the legacy inline-admission adapter, and that pass-through is
out of this change's scope. The floor moves to 2 only after legacy retirement.

#### Scenario: Each group's post-change count is measured, not inferred

- **WHEN** the dependency-budget gate's measurement function is run over the post-change
  `guardrails.service.ts`
- **THEN** it reports provisioning-diagnostics recorder 2, write gate 2, transcripts 1, and
  metrics-projection 2 — the last measured against the collaborator's NEW symbol, since measuring the
  old one would report a zero that only the rename produced — and each of those numbers appears in the
  change's records with the command that produced it

#### Scenario: The awaited transcript capture survives at its seam

- **WHEN** a task reaches a terminal state through either terminal chokepoint
- **THEN** the transcript capture is still awaited to completion BEFORE the stop-only teardown runs,
  the surviving reference is that awaited call, and the transition, teardown, and slot release still
  proceed unconditionally when capture fails

#### Scenario: The diagnostics pass-through into legacy is untouched

- **WHEN** the orchestrator's construction of the legacy inline-admission pipeline is read
- **THEN** it still passes both the diagnostic recorder and the write gate, so both constructor
  parameters remain live and the group's floor is 4 rather than 2

#### Scenario: No group is reported as burned down

- **WHEN** the change's records describing the three outcomes are read
- **THEN** none of the three is described as burned down or as reaching zero, and in particular
  metrics-projection is described as unmoved at 2 with its entry retained, because its old symbol's
  zero was a rename rather than a removal

## MODIFIED Requirements

### Requirement: The orchestrator constructor and its positional construction sites are untouched

`GuardrailsService` SHALL keep exactly its existing 11 constructor parameters in their existing
order and types, with the `@Optional()` bus still last, so that the 24 positional
`new GuardrailsService(...)` sites across 17 files (12 of them outside `apps/api/src/guardrails/`)
compile and run unchanged. The site count is measured, not asserted, and it moves under this
requirement's own nose: it was 22 across 15 files, then 23 across 16 when a later change added an
integration test that constructs the orchestrator positionally, and it is 24 across 17 now that this
change's transcript-ordering assertion constructs one too. The numbers here were re-counted live on
the integrated tree rather than carried forward — the previously recorded "12 of them outside" was
already one ahead of a live count of 11 when it was written, which is exactly how a stale count makes
a future change mis-scope the blast radius of touching the signature. The `runnerMinutes` member SHALL be usable from the moment an instance
exists under BOTH DI construction and positional construction: an instance built positionally,
with no injector from which to resolve the port, SHALL still answer `recordStart`, `recordEnd`,
and `intervals()` without a null-reference error, because existing reflective unit assertions
call `intervals()` on positionally constructed instances. The injector-less fallback SHALL be
initialized by a field initializer, which the compiler emits before the constructor body runs, so
it is in place before any collaborator the constructor builds can reach the member.

Removing any of the three collaborator parameters is OUT of scope for a change that keeps this
requirement, and the reason is measured rather than stylistic: **20** of those construction sites
pass a value in the transcripts position or beyond, **16** of them across **9** files outside
`apps/api/src/guardrails/`, and one of them is `guardrails.service.spec.ts`, which a standing
requirement freezes at zero diff. The threshold that produces those numbers SHALL be stated with
them, because it is where this count goes wrong: `transcripts` is the EIGHTH parameter, so the
affected set is every site passing at least eight arguments — including the six that pass exactly
eight, whose final argument IS the transcripts value. Counting from nine instead silently drops
those six and understates the blast radius by a quarter, which is precisely the mis-scoping this
requirement exists to prevent. A change that needs the parameters gone SHALL modify this requirement
in the same commit as the signature.

#### Scenario: The constructor signature is unchanged

- **WHEN** the `GuardrailsService` constructor signature is compared with its pre-change form
- **THEN** it has the same 11 parameters in the same order and types, the bus is still the last
  parameter and still `@Optional()`, and zero of the 24 positional construction sites were edited
  to pass a ledger or port argument

#### Scenario: A positionally constructed instance still accounts for runner minutes

- **WHEN** a `GuardrailsService` is constructed positionally (no injector available) and a task is
  admitted, started, and settled
- **THEN** the start and end are recorded and `runnerMinutes.intervals()` returns the closed
  interval, with no null-reference or undefined-field error at any point in the lifecycle

#### Scenario: The reflective internals assertions pass unmodified

- **WHEN** `apps/api/src/guardrails/guardrails.service.spec.ts` is run on the integrated tree
- **THEN** it passes with zero diff lines, including its seven reflective
  `internals.runnerMinutes.intervals()` assertions (14 occurrences of the identifier, at
  `:1375`/`:1380`, `:3011`/`:3021`, `:3072`/`:3078`, `:3132`/`:3136`, `:3199`/`:3207`,
  `:3274`/`:3280`, `:3341`/`:3347`)

#### Scenario: The recorded site count matches a live count

- **WHEN** the tree is searched for `new GuardrailsService(` outside comment lines
- **THEN** the number of construction sites and the number of files containing them equal the counts
  this requirement states, so a change reading this requirement to scope a signature edit is reading
  a live number
