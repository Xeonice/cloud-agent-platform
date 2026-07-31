## ADDED Requirements

### Requirement: A rule the contracts package states SHALL be executed against the wire it describes

A schema in the contracts package SHALL be parsed by production code — directly, or
through a schema composed from it — or SHALL declare itself an exception with a
reason. A schema nothing executes is not a rule; it is a comment that resembles
one, and it can contradict what is actually sent with no signal anywhere.

Execution SHALL be measured, not assumed. Reachability by import is a different
property and does not imply it: a schema every consumer imports the TYPE of, and
no consumer ever parses, is unexecuted.

Where parsing happens through indirection — a table, registry or dispatcher whose
call site names a property path rather than the schema — the indirection point
SHALL be declared, naming the location where the parse occurs and the entries it
covers. It SHALL NOT be inferred, because a rule that treats everything reachable
from a large object as executed grants a blanket amnesty to whatever is put in
that object next.

A schema executed only by the package's own tests SHALL be reported as such. A
test call site proves the schema parses; it does not prove anything on the wire
conforms to it.

#### Scenario: An unexecuted schema stops the build

- **WHEN** the contracts package declares a schema that no production code parses,
  that no parsed schema is composed from, that no declared indirection point
  covers, and that no exception covers
- **THEN** the build SHALL fail, naming the schema

#### Scenario: Indirect execution is declared, not guessed

- **WHEN** production code parses a schema through a table or registry entry, so
  that the call site names a property path rather than the schema
- **THEN** that indirection point SHALL be declared with its location, and only the
  entries it covers SHALL count as executed through it

#### Scenario: A test call site does not stand in for a production one

- **WHEN** a schema is parsed only by the package's own tests
- **THEN** it SHALL be reported as test-only rather than counted as executed,
  because the drift such a check exists to catch is between the declaration and
  the bytes production sends

#### Scenario: The check is proved against the shape it exists to catch

- **WHEN** the check is added or changed
- **THEN** the throwaway used to prove it fails SHALL have the shape of the defect
  it targets — a schema that IS imported and IS composed into a live type and is
  never parsed — and not merely some shape the check happens to reject, because a
  check proved against the easy shape leaves the class it was built for walking
  through

## MODIFIED Requirements

### Requirement: A shared type SHALL have exactly one declaration

A type that crosses the boundary between the api and the console SHALL be declared
once, in the shared contracts package, and consumers SHALL obtain it by import. A
consumer SHALL NOT restate a shared type locally, whether by copying its members,
by re-typing its fields, or under a different name.

**A local ALIAS of a shared declaration is a restatement**, even though it copies
nothing and cannot drift. It costs something the copy-based reading does not
capture: any check that asks whether a declaration is used, imported or executed
attributes the use to the ALIAS, so the shared declaration reads as unused while
production runs it under another name. A rename that is invisible to a reader is
still opaque to a checker, and the checker is what the single-declaration rule
relies on to stay true.

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

#### Scenario: A convenience alias is not a convergence

- **WHEN** a consumer replaces a local copy with a local alias of the shared
  declaration, so that its own call sites keep the name they already used
- **THEN** that is NOT convergence: the call sites SHALL name the shared
  declaration directly, because an alias leaves every reachability and execution
  check attributing the use to the local name and reporting the shared one as
  unused

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

**A schema/type twin SHALL NOT vouch for itself.** The pair line
`export type X = z.infer<typeof XSchema>` is the pair, not a use of it, and a check
that counts it as composition marks every schema in the package reachable before
the pair rule is ever consulted — which is to say, silently stops checking.

**The consumer set SHALL include every directory that imports the package, not only
workspace packages that declare a manifest dependency.** Repository-level scripts
import contracts too, and a scan blind to them can report an export unreachable
while a script imports it, and can carry an exception whose stated reason a file
outside the scan already falsifies.

An export reachable only from the package's own tests SHALL be reported as such
rather than counted as shared. It is neither dead nor shared, and the two answers
differ.

An export that is legitimately unreachable SHALL declare itself as an exception with
a reason, so the exception is visible in review rather than invisible by omission.
**An exception whose stated reason measurement contradicts SHALL be removed, not
reworded**, because the reason is the whole content of an exception.

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

#### Scenario: A dead schema/type pair is reported despite its own pair line

- **WHEN** neither half of a schema/type pair is imported, composed into anything,
  or otherwise reachable, and the only reference to either is the pair line joining
  them
- **THEN** the build SHALL fail naming both halves, because a pair that vouches for
  itself makes the rule unfalsifiable

#### Scenario: A schema nobody executes is treated as unverified

- **WHEN** a contract schema has no call site anywhere
- **THEN** it SHALL be reported, because a declaration nothing enforces can
  contradict what is actually sent without any signal

#### Scenario: A repository script counts as a consumer

- **WHEN** a file outside the workspace packages — a repository-level script or its
  test — imports the contracts package
- **THEN** that import SHALL count toward reachability, so no export is reported
  dead while something in the repository uses it

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
