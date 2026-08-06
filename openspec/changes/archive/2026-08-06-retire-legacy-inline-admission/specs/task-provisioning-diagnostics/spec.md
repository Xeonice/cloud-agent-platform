## ADDED Requirements

### Requirement: Narrowing the admission-mode enum is a data change, not only a contract change

The published admission-mode enum SHALL lose its legacy member, and the change SHALL treat that as
what it is: the enum is not a presentation detail but the validator for a PERSISTED column on two
tables, applied on the read path. Narrowing it without touching the data would leave the service
unable to parse rows it wrote itself — every historical diagnostic row recording legacy admission
would fail validation when read back, and the failure would surface as a broken read of old tasks
rather than as a contract break for callers.

The change SHALL therefore carry a migration that makes the stored values consistent with the
narrowed enum. The migration SHALL DELETE the rows recording legacy admission rather than rewriting
them to the surviving value: rewriting would assert that those tasks were admitted durably when they
were not, and this table exists to answer, after the fact, which path a task took. Destroying the
record honestly is preferable to preserving a falsified one.

The migration SHALL be recognised as IRREVERSIBLE and SHALL say so where an operator will read it.
The column is a plain string rather than a database enum, so nothing at the schema level constrains
it and nothing at the schema level can restore it; the deletion is a data change whose only rollback
is a backup.

#### Scenario: The narrowed enum admits exactly one value

- **WHEN** the published admission-mode enum is read, in both the diagnostics contract and the
  domain-event contract that re-exports it
- **THEN** it declares the durable member and no legacy member, and every consumer of either schema
  compiles against the narrowed union

#### Scenario: No stored row contradicts the narrowed enum

- **WHEN** the persisted admission-mode column on both tables is queried for values outside the
  narrowed enum, after the migration has run
- **THEN** zero rows are returned, so the read path can no longer encounter a value its validator
  rejects

#### Scenario: The migration deletes rather than rewrites

- **WHEN** the migration is read
- **THEN** it removes the rows recording legacy admission and contains no statement assigning the
  surviving value to a row that did not already hold it, so no task's recorded admission path is
  falsified

#### Scenario: The irreversibility is stated where it is run

- **WHEN** the migration and the change's records are read for what happens on rollback
- **THEN** both state that the deletion cannot be undone by reverting the code, because the column is
  an unconstrained string and the rows are gone
