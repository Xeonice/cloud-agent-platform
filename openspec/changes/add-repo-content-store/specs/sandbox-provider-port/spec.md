# sandbox-provider-port Specification (delta)

## ADDED Requirements

### Requirement: Provision context carries a typed WorkspaceSource union

The provision context SHALL carry the workspace origin as a typed union `WorkspaceSource` with at least the variants: `volume` (repo-store copy exposed via read-only per-repo mount), `archive` (repo-store copy transferred as an archive stream), and `git` (legacy in-sandbox network clone spec). The union SHALL be defined in `packages/sandbox-core` and replace the bare clone-spec as the provider-facing workspace intent. Providers SHALL declare which variants they support via the existing capability vocabulary.

#### Scenario: Provider receives a typed source
- **WHEN** orchestration provisions a task on a provider supporting `volume`
- **THEN** the provider receives a `volume` WorkspaceSource identifying the task's repo copy, not a raw clone URL

#### Scenario: Capability declaration gates variant selection
- **WHEN** the orchestrator selects an injection variant for a provider
- **THEN** only variants the provider declares are eligible

### Requirement: Repo-copy injection is the primary materialization path and git fallback is explicitly gated

Workspace materialization SHALL default to injecting the Repo's stored content copy (`volume` or `archive` variant per provider capability). The `git` variant (in-sandbox network clone) SHALL be selectable only through an explicit operator-facing configuration gate, defaulting to off, and its use SHALL be observable (diagnostics name the variant used). Orchestration SHALL fail closed with an actionable error when no supported variant is available, not silently fall back to `git`.

#### Scenario: Default provisioning uses injection
- **WHEN** a task provisions with default configuration on aio-local or boxlite
- **THEN** materialization consumes the stored copy and no network git clone runs inside the sandbox

#### Scenario: No silent git fallback
- **WHEN** a provider supports no injection variant and the git fallback gate is off
- **THEN** provisioning fails with an error naming the missing capability and the gate

### Requirement: Injected workspaces converge to the same git shape as cloned ones

Regardless of injection variant, the materialized workspace SHALL be a normal git working tree whose `origin` remote points at the Repo's recorded git source, so delivery (in-sandbox git push) and agent git operations behave identically to a workspace produced by the legacy clone path.

#### Scenario: Origin points at the real source after injection
- **WHEN** a workspace is materialized via `volume` or `archive` injection
- **THEN** `git remote get-url origin` in the workspace returns the Repo's recorded git source
- **AND** configured delivery behaves as before
