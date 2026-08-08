## Why

<!-- Explain the motivation for this change. What problem does this solve? Why now? -->

## What Changes

<!-- Describe what will change. Be specific about new capabilities, modifications, or removals. -->

## Capabilities

### New Capabilities
<!-- Capabilities being introduced. Replace <name> with kebab-case identifier (e.g., user-auth, data-export, api-rate-limiting). Each creates specs/<name>/spec.md -->
- `<name>`: <brief description of what this capability covers>

### Modified Capabilities
<!-- Existing capabilities whose REQUIREMENTS are changing (not just implementation).
     Only list here if spec-level behavior changes. Each needs a delta spec file.
     Use existing spec names from openspec/specs/. Leave empty if no requirement changes. -->
- `<existing-name>`: <what requirement is changing>

## Impact

<!-- Affected code, APIs, dependencies, systems -->

<!-- MIGRATIONS. If this change adds a Prisma migration, say which side of the
     additive-only definition it lands on (docs/refactor/04-rules-registry.md §E):

       - DDL-additive — no DROP COLUMN, no DROP TABLE, no SET NOT NULL on an
         existing column, so N-1 code still boots against the new schema; or
       - DML, with the irreversibility declared IN THE MIGRATION FILE ITSELF,
         where the operator running it will read it.

     Delete this comment if the change carries no migration. Answering it is the
     only enforcement this rule has: both CI compatibility jobs it names are
     non-required today. -->
