## ADDED Requirements

### Requirement: Package-internal imports use a path alias, not relative traversal

An application or package SHALL refer to its own modules through a path alias
rooted at that package's source directory, not by relative traversal out of the
importing directory. `apps/web` already establishes the convention (`@/*` →
`./src/*`); the repository SHALL use ONE such convention rather than a different
answer per package.

The purpose is relocation: a directory whose consumers name it by position
relative to themselves cannot be moved without editing every consumer, which is
what makes reorganising a large module tree a manual exercise instead of a
mechanical one.

The alias SHALL resolve in every path the package is built or tested through —
the application build, the compiled test runner, and any standalone compilation
harness — so that adopting it cannot leave one lane silently unable to resolve
what the others can.

#### Scenario: A module is referred to by alias rather than traversal
- **WHEN** a source file inside an application imports another module of the same application
- **THEN** it names it by the package's alias
- **AND** no relative traversal out of the importing directory appears

#### Scenario: The alias resolves in every build and test lane
- **WHEN** the application is built, its compiled suite is run, and a standalone compilation harness compiles a single source file
- **THEN** the alias resolves in all of them
- **AND** no lane requires a second convention to resolve what the others resolve

#### Scenario: A newly added relative import fails the build
- **WHEN** a source file is added that traverses out of its directory to reach another module of the same package
- **THEN** a repository check fails and names the file

### Requirement: Directory dependencies are acyclic outside module composition

Two directories of an application SHALL NOT depend on each other through
non-module source. A mutual dependency between directories means neither owns
the concern they share, and it is what prevents either from being moved,
extracted, or reasoned about independently.

Dependency-injection COMPOSITION is exempt and SHALL be stated as such: imports
made BY a `*.module.ts` file — of another module, or of a provider class it
registers — are composition, because a framework whose composition model
requires them would otherwise be satisfied by indirection that hides the same
cycle rather than removing it. The exemption SHALL be narrow, and it is about
the IMPORTING file: a cycle in which any participating import comes from
ordinary source is NOT composition and is forbidden.

Where a symbol is reached for by a directory that does not own it, the symbol
SHALL be moved to a home named for what it IS, rather than left in a feature
directory that consumers must reach into. A single catch-all destination SHALL
NOT be used: a name that describes nothing cannot say what does or does not
belong in it.

#### Scenario: Two directories forming a mutual dependency fail the build
- **WHEN** ordinary source in one directory imports another directory that imports it back
- **THEN** a repository check fails and names both directories
- **AND** the check names the imports that form the cycle

#### Scenario: Module composition may be mutual
- **WHEN** two directories depend on each other ONLY through imports written in `*.module.ts` files — whether of another module or of a provider class being registered
- **THEN** the check passes
- **AND** the exemption is visible in the check as a stated rule rather than an unexplained absence

#### Scenario: A cycle with any ordinary-source import is not composition
- **WHEN** two directories form a mutual dependency in which at least one import is written in a file that is not a `*.module.ts`
- **THEN** the check fails
- **AND** it is not treated as composition merely because the other side is a module file

#### Scenario: A shared symbol lives where its name says
- **WHEN** a symbol is used by directories that do not own it
- **THEN** it lives in a directory named for the concern it belongs to
- **AND** that directory is not a general-purpose destination for unrelated symbols
