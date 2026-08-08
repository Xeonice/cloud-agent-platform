# task-lifecycle-vocabulary Specification

## Purpose
TBD - created by archiving change lifecycle-vocabulary-single-declaration. Update Purpose after archive.
## Requirements
### Requirement: The terminal-status vocabulary has exactly one canonical declaration

The set of terminal task statuses SHALL be declared exactly once across `apps/api` and
`packages/contracts`, and that declaration SHALL be `TERMINAL_TASK_STATUSES` in
`packages/contracts/src/task.ts`. Every other position that needs the set SHALL derive it from that
declaration rather than restate it.

The direction is forced, not preferred. The two declarations that exist today
(`packages/contracts/src/task.ts:42` and `apps/api/src/task-lifecycle/task-lifecycle.ts:18`) have
byte-identical members, so either could have been kept on grounds of content — but `apps/web` cannot
import `apps/api`, and the contracts version already has consumers in both the web app and the
contracts package. Keeping the api version would require changing consumers that structurally cannot
reach it.

A `domain`-layer module depending on `@cap-console/contracts` for a TYPE or a frozen literal set is
NOT a layering violation and SHALL NOT be treated as one: artifact 08 §G forbids decorators, DI, and
IO in the domain layer, not contract types, and `task-lifecycle.ts:1` already imports one.

⚠ The counting convention in the requirement below EXCLUDES test files, and that exclusion has a blind
spot this change walked into THREE TIMES. A test file may hold its own definition of terminality — same
members, any name, any shape — and no site count will see it. Adversarial review found four across two
rounds: a same-named copy in `startup-recovery.test.mjs`, a `function` equality chain in
`tasks-durable-admission-crash-matrix.spec.ts`, an inline chain in `guardrails-exit-roundtrip.test.mjs`
(whose own comment said it mirrored the production predicate), and a double-quoted `Set` under the
canonical's name in the web e2e suite. Each escaped a check written just after the previous one,
because each check keyed on the shape of the copy it had last seen.

So the check for THIS requirement scans for the DEFINITION SHAPE, across every source file including
tests, in either quote style, without keying on a symbol name. A carrier is (i) an array or `Set`
literal whose elements are exactly the four terminal statuses, (ii) an equality chain covering exactly
those four, (iii) a `switch` whose case labels are exactly those four and no non-terminal status, or
(iv) a literal type union of exactly those four.

**Form (iv) exists because leaving it out made this requirement contradict itself.** The "Real
restatements — 9 sites" paragraph below counts two TYPE UNIONS in the orchestrator among the
restatements this change removes, so a definition that excluded type unions declared the same shape to
be a restatement in one paragraph and not a carrier in another. The defence offered for the exclusion —
that a type union is erased at runtime and so cannot decide terminality — is not a reason: erasure
changes when the copy is read, not whether it exists. A union of exactly the four terminal statuses is
a second written statement of the set, and the next terminal status added will neither update it nor
break it.

**Form (iii) is the line between a total mapping and a restatement, and it decides the two positions
this requirement exempts.** A switch that enumerates EVERY member of the status enum is a total mapping
whose exhaustiveness the compiler checks — adding a status breaks the build, which is the property
worth having. A switch that names only the four terminal statuses and lets a `default` absorb the rest
has encoded WHICH statuses are terminal, and the next terminal status added will fall into that default
and be answered silently. `packages/contracts/src/session-history.ts` held exactly that shape:
`replayPresentationState` named the four terminal statuses and defaulted everything else to
`"completed"`, three lines above an `isReplayableStatus` deriving the same fact from the canonical set.
It is now exhaustive over all eight, with the non-terminal arms returning what the default returned, so
behaviour is unchanged and a ninth status stops compiling instead of being answered wrongly.

The carrier definition has been widened three times, each time by a refutation rather than by
foresight, and each time the miss was a SHAPE and never a name. That is worth stating plainly: a
shape-based check is a list of the disguises seen so far, so this one SHALL be widened again when a
fourth is found rather than defended.

**Two shapes are legitimate test INPUT and are excluded by FORM, not by path** — a path exemption list
would rot as files move:

- the iterand of a `for (… of [four literals])`, which feeds statuses into assertions rather than
  deciding which statuses are terminal; and
- the four literals inside a Prisma `in:` clause in an EXPECTED-QUERY fixture, which pins the query a
  service must build.

Deriving either from the canonical declaration would make the expected value share a source with the
actual one, and an assertion whose two sides move together has stopped asserting anything. This is the
same judgement the requirement below makes for the two total mappings, applied to test inputs.

#### Scenario: One canonical declaration survives

- **WHEN** the repository is searched for a declaration of the terminal status set
- **THEN** exactly one exists, in `packages/contracts`, and every consumer in `apps/api` reaches it by
  import rather than by restating the members

#### Scenario: The retired declaration leaves no forwarding alias

- **WHEN** the lifecycle module is read after the change
- **THEN** it does not declare a second name for the same set — a re-export that renames the canonical
  set reintroduces the two-name problem this requirement exists to remove, while looking like a fix

#### Scenario: No copy of the set survives in a test either

- **WHEN** every source file, tests included, is scanned for a declaration binding the four terminal
  literals to a name
- **THEN** exactly one such declaration exists, and it is the canonical one in the contracts package

#### Scenario: The terminal predicate narrows, so consumers need no predicate of their own

- **WHEN** a consumer must narrow a `TaskStatus` to the terminal union
- **THEN** the lifecycle module's terminal predicate is a type guard that gives it that narrowing, so
  the consumer consumes rather than declares — the orchestrator kept its own narrowing predicate until
  this change precisely because the shared one could not narrow

### Requirement: Restatements of the terminal vocabulary are counted per SITE, and the convention's false positives are named

Restatements SHALL be counted per SITE, not per file, and the figure SHALL be recorded with the
command and counting convention that produced it. The positions the convention counts but that are NOT
restatements SHALL be named individually, so nobody "fixes" one.

The convention: a site is a window of 8 lines containing all four terminal literals
(`completed`, `failed`, `cancelled`, `agent_failed_to_start`) in single quotes, scanning `apps/`,
`packages/`, `scripts/`, excluding `*.spec.ts`, `*.test.ts`, `*.test.mjs`, advancing non-overlapping so
one position is counted once. Measured on the pre-change tree: **15 sites across 7 files**. Including
tests instead of excluding them gives 18 files; both come from the same command with one list emptied.

⚠ **Counting one site per file understates this by more than half — 7 versus 15 — and the figure
recorded in this change's own research brief (12) was wrong on top of that.** Re-measuring under the
brief's stated exclusions gives 13 files, and its exclusion list was itself inconsistent: it excluded
two test suffixes and not `*.test.mjs`, so it counted test files while claiming to exclude them. Both
errors are kept on the record. The per-file figure specifically hid FIVE restatements inside
`guardrails.service.ts`, which is the file that matters most here — a first-occurrence-per-file count
is not a burn-down measure and SHALL NOT be used as one.

**Canonical — 3 sites, keep.** `packages/contracts/src/task.ts:30` (the full status enum) and `:39`
(the terminal set itself); `apps/api/src/task-lifecycle/task-lifecycle.ts:40`, the terminal rows of the
adjacency table, which enumerate legitimately because that table IS the declaration of the edges.

**Doomed canonical — 1 site.** `apps/api/src/task-lifecycle/task-lifecycle.ts:15`, the second
declaration this change removes.

**False positives of the convention — 2 sites, keep, and named so they are never converted.**
`apps/api/src/audit/audit-mapping.ts:282` is an exhaustive `switch` over the WHOLE status enum mapping
each status to an audit event type; `apps/api/src/v1/v1-events.controller.ts:324` is the same shape in
the inverse direction. The four terminal literals co-occur because their arms are adjacent, not because
the set is restated. Both must keep naming every member: rewriting either to consume the terminal set
would REMOVE a compiler-enforced total mapping in the name of tidiness.

**Real restatements — 9 sites.** Five in `apps/api/src/guardrails/guardrails.service.ts`: two type
unions (`:169`, `:3256`), two equality chains (`:981`, `:3295`), and a locally redeclared
`isTerminalTaskStatus` predicate (`:3613`). Two Prisma `in` arrays in
`apps/api/src/tasks/tasks.service.ts` (`:693`, `:743`). Two raw-SQL lists in
`apps/api/src/task-admission/prisma-task-admission.store.ts` (`:95`, `:127`).

Each SHALL either derive its members from the canonical declaration or be named in the change
description as a deliberate exemption with the reason.

`guardrails.service.ts` SHALL derive from `@cap-console/contracts`, which it already imports at `:22`,
rather than from the task-lifecycle module.

⚠ The reason first recorded for this was WRONG and is corrected here rather than quietly replaced. It
said the two are different contexts and that the import would create a `cross-context-import` finding.
They are the SAME context — `docs/refactor/contexts-manifest.json` puts `tasks`, `task-operations`,
`task-lifecycle` and `guardrails` all in `task-execution` — so the cross-context branch is never
entered, and layer direction is deferred while the target is unclassified
(`scripts/context-layout-check-v2.mjs:485`) and legal once it is `domain`. That import would produce
no finding at all.

What survives is a narrower and truer rule, and it is about OWNERSHIP rather than boundaries: each
piece comes from whoever declares it. The terminal SET is a vocabulary the contracts package owns, so
the type derived from it belongs beside it there — declaring that type in `apps/api` would put a second
name for a contracts-owned vocabulary in a consumer, the same shape as the duplicate declaration this
change removes. The terminal PREDICATE is owned by the lifecycle module, so the orchestrator SHALL
consume that one rather than keep its own; it kept a private copy spelling out the four literals, which
is how this file became the fifth place the vocabulary was written down and — because a
first-hit-per-file count cannot see a fifth occurrence — the one nobody was counting.

**MEASURED on the integrated tree: 15 → 5 sites across 4 files**, and the five are exactly the ones
named above — `packages/contracts/src/task.ts:30` and `:39`, the adjacency table's terminal rows, and
the two false positives. The prediction and the measurement agree; both are recorded so a later reader
can see which was which.

A bare grep for `agent_failed_to_start` is NOT this measurement and SHALL NOT be substituted for it: it
returns 45 lines, overwhelmingly SINGLE-status references with nothing to do with the terminal set —
`circuit-breaker.ts`'s `FailureKind`, `task-transcript-reader.ts:68`'s single comparison.

`TERMINAL_STATUSES` in `apps/api/src/settings/codex-device-login.service.ts:59` is a NAME collision
over a different enum (`DeviceLoginStatus`) and SHALL be left alone. It is named here because the
retiring declaration shares its name exactly, and a symbol-name sweep would reach it.

#### Scenario: The recorded site count matches a live count under the stated convention

- **WHEN** the restatement count is re-measured with the convention this requirement states
- **THEN** it equals the recorded figure, so a reader scoping later work is reading a live number

#### Scenario: A new restatement is visible to the recorded measurement

- **WHEN** a change adds a site where all four terminal literals co-occur outside the canonical
  declarations and outside the two named false positives, and the count is re-measured under the
  convention this requirement states
- **THEN** it reads above the recorded figure

⚠ This scenario said "and the gate reports it" until verify adjudicated it as a requirement defect,
and the adjudication was right: **nothing in `scripts/` counts this** — `grep -rn agent_failed_to_start
scripts/` returns zero — and this change explicitly declines to build a gate (see the proposal's
Impact). The only thing measuring it is this change's own `assertions.json`, which runs once at verify
and never again after archive. So the old wording asserted an enforcement that does not exist, which is
the same "true in one place, false in another" defect the requirement exists to prevent — asserted, of
all places, by the requirement itself. What is claimed now is what is real: a REPRODUCIBLE MEASUREMENT
CONVENTION, not an automatic check. Building the gate is a legitimate follow-up and belongs in its own
change, because a standing check is new mechanism and this cut adjudicated that it builds none.

#### Scenario: The two total mappings are left naming every member

- **WHEN** the audit mapping and the event-type mapping are read after this change
- **THEN** each still enumerates every status arm explicitly, because their exhaustiveness is what the
  compiler checks and consuming a terminal-set constant would silently remove that check

#### Scenario: The burn-down creates no finding in another class

- **WHEN** the layout v2 check is run after the nine restatements are derived
- **THEN** no finding class has risen — the derivation reaches a package import, which the governed-file
  analysis does not resolve to a layer or a context at all

### Requirement: The admission transition subset is declared once and consumed, not restated

The subset of transitions admission owns SHALL exist as one exported predicate, and every position
needing that rule SHALL call it. The subset is `pending → queued`, `pending → running`, and
`queued → running`.

Today the rule exists three times in two forms that no tool relates to each other: prose in
`apps/api/src/tasks/tasks.service.ts:2440`, and a type restatement
`Extract<TaskStatus, 'pending' | 'queued' | 'running'>` in both
`apps/api/src/tasks/tasks.service.ts:176` and `apps/api/src/task-operations/task-operations.port.ts:54`.
A prose sentence and a type expression cannot disagree loudly — they disagree silently.

`apps/api/src/task-admission/task-admission.worker.ts:1131` already delegates to `canTransition` and
SHALL remain a CONSUMER. This requirement adds a declaration; it does not move an existing consumer,
because moving a correct consumer is churn that the gates cannot tell apart from progress.

#### Scenario: The subset rule has one declaration

- **WHEN** the repository is searched for the admission-owned transition subset
- **THEN** exactly one exported declaration exists, and the type positions derive from it

#### Scenario: The existing consumer is untouched

- **WHEN** `task-admission.worker.ts` is compared with its pre-change form
- **THEN** its delegation to the lifecycle module is unchanged

### Requirement: The test guarding the lifecycle vocabulary fails when the vocabulary changes

The test covering task lifecycle transitions SHALL import the module it tests. It SHALL NOT hold its
own copy of the transition table.

`apps/api/src/tasks/task-lifecycle.test.mjs` imports only `node:test` and `node:assert/strict` and
carries its own adjacency table. Editing `ALLOWED_TRANSITIONS` in the real module leaves it green. That
is not weak coverage — it is a test that CANNOT fail for the reason it exists, and it reports success
either way, which is worse than having no test at all because it occupies the place where a real one
would be noticed as missing.

The fix SHALL be to import the real module. Retiring the test instead is permitted ONLY if, after
wiring it, its assertions are measured to be redundant with an existing suite — and that measurement
SHALL be recorded. Retiring first and measuring never is how coverage is lost while a task ledger shows
work done.

#### Scenario: Changing the real transition table breaks the test

- **WHEN** an edge is removed from `ALLOWED_TRANSITIONS` in the module under test
- **THEN** the test fails

#### Scenario: The test holds no second copy of the table

- **WHEN** the test file is searched for a transition table
- **THEN** none is declared in it; the table it asserts against comes from the imported module

### Requirement: Migration discipline is defined in writing before it is enforced

The repository SHALL carry a written definition of "additive-only" for Prisma migrations, and changes
that add a migration SHALL state which part of that definition they land on.

The definition SHALL be: DDL must be additive — no `DROP COLUMN`, no `DROP TABLE`, no `SET NOT NULL` on
an existing column — while DML is permitted provided the migration states its irreversibility in the
file itself. This is the loose reading, chosen deliberately over "no data changes at all": the strict
reading would have failed two migrations already merged, including one from phase 4 that had ALREADY
volunteered an irreversibility note at the top of the file. A rule whose first act is to condemn the
practice it was written to describe is a rule nobody will keep.

This requirement adds a DEFINITION and a change-template clause, not a gate.
`docs/refactor/04-rules-registry.md` §E already names the enforcers — two existing CI compatibility
jobs plus "阶段 5 起的 change 模板条款" — so the missing piece was never the mechanism.

⚠ Both named CI jobs are NON-REQUIRED checks today, and the N-1 fixture is pinned nine releases behind
the current tag. Neither is fixed here. This requirement SHALL NOT be read as claiming migration
compatibility is enforced — it claims only that the definition exists and is stated per change.

#### Scenario: The definition is written down and reachable

- **WHEN** a contributor looks for what "additive-only" means in this repository
- **THEN** one definition exists in the rules registry, and it distinguishes DDL from DML explicitly

#### Scenario: A migration-bearing change states its position

- **WHEN** a change adds a Prisma migration
- **THEN** its artifacts state whether the migration is DDL-additive, or DML with the irreversibility
  declared in the migration file

