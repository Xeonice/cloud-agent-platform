## ADDED Requirements

### Requirement: A shared type SHALL have exactly one declaration

A type that crosses the boundary between the api and the console SHALL be declared
once, in the shared contracts package, and consumers SHALL obtain it by import. A
consumer SHALL NOT restate a shared type locally, whether by copying its members,
by re-typing its fields, or under a different name.

Where a consumer package deliberately limits its runtime dependencies, it SHALL
converge through a type-only import rather than by keeping a copy, because a
type-only import is erased and therefore costs that package nothing it was
protecting.

A restatement SHALL NOT be justified by the copy currently matching. Two
declarations that agree today agree only until one is edited, and the
repository has no mechanism that notices.

#### Scenario: A consumer imports rather than restates

- **WHEN** a consumer needs a type the contracts package already declares
- **THEN** it SHALL import that declaration, so the two cannot drift apart

#### Scenario: A dependency-constrained package still converges

- **WHEN** the consumer is a package that deliberately declares no runtime
  dependencies, and it needs the type only in type position
- **THEN** it SHALL take a type-only import, which leaves its runtime dependency
  graph unchanged, rather than keep a local copy

#### Scenario: A runtime need that cannot be imported is reconciled, not duplicated silently

- **WHEN** a dependency-constrained package needs the vocabulary as a runtime value
  and therefore cannot import it
- **THEN** its local copy SHALL be reconciled with the declaration by a check that
  fails when the two disagree, and any deliberate widening SHALL be stated as an
  extension of the declaration rather than as an independent list

### Requirement: An export nothing can reach SHALL fail the build

The contracts package SHALL NOT retain an export that nothing can reach. Such an
export is not shared, and the package's stated purpose is that everything in it is.

Reachability SHALL be judged by what actually keeps an export alive, not by whether
a consumer names it. An export is reachable when a consumer imports it, when
another export is composed from it, or when the schema/type twin it forms a unit
with is itself reachable — this package's documented pattern is a zod schema
alongside the type inferred from it, and a consumer that validates with the schema
never names the type. A check that demanded a direct import would flag most of the
package and be turned off; the requirement is that nothing is unreachable, not that
everything is imported.

An export reachable only from the package's own tests SHALL be reported as such
rather than counted as shared. It is neither dead nor shared, and the two answers
differ.

An export that is legitimately unreachable SHALL declare itself as an exception with
a reason, so the exception is visible in review rather than invisible by omission.

A dead export SHALL NOT be removed before the consumers that displaced it have been
converged. An export is frequently dead **because** a consumer restated it — including
by inlining its VALUE as a literal, which leaves no second declaration for a
name-based scan to find — and deleting it first ratifies the restatement, after which
the same shape reappears under another name.

#### Scenario: An unreachable export stops the build

- **WHEN** the contracts package exports a symbol that no consumer imports, that no
  other export is composed from, whose schema/type twin is equally unreachable, and
  that no exception covers
- **THEN** the build SHALL fail, naming the export

#### Scenario: A composed or paired export is not reported dead

- **WHEN** an export is not imported by any consumer, but another export is built
  from it or its schema/type twin is imported
- **THEN** it SHALL NOT be reported, because deleting it would leave the next
  consumer that needs it re-declaring it locally

#### Scenario: A schema nobody executes is treated as unverified

- **WHEN** a contract schema has no call site anywhere
- **THEN** it SHALL be reported, because a declaration nothing enforces can
  contradict what is actually sent without any signal

#### Scenario: Convergence precedes deletion

- **WHEN** an export is found to be unreachable while a consumer holds a local
  restatement of it, whether as a declaration or as an inlined literal value
- **THEN** the restatement SHALL be converged first and reachability re-measured,
  and only the exports still unreachable afterwards SHALL be removed

#### Scenario: The check is shown to be able to fail

- **WHEN** the check is added or changed
- **THEN** a throwaway unreachable export SHALL be shown to fail it by name and its
  removal SHALL be shown to return the build to green, because a check accepted on
  a green run has not been shown to do anything
