# local-repo-import Specification

## Purpose
TBD - created by archiving change add-repo-content-store. Update Purpose after archive.
## Requirements
### Requirement: Local path import is fail-closed behind a configured allowlist root

The system SHALL support importing an existing git repository from a filesystem path visible to the api process ONLY when the `CAP_LOCAL_IMPORT_ROOT` environment variable is configured. When unset, local path import SHALL be disabled end to end (API rejects, console does not offer the mode). A requested path SHALL be resolved (realpath, symlinks followed) and MUST be contained within the configured root after resolution; paths escaping the root (including via `..` or symlinks) SHALL be rejected with a typed error that does not disclose filesystem contents outside the root.

#### Scenario: Feature off when env unset
- **WHEN** `CAP_LOCAL_IMPORT_ROOT` is not configured and a local import is requested via API
- **THEN** the request is rejected with an actionable "feature disabled" error

#### Scenario: Symlink escape is rejected
- **WHEN** a path inside the root resolves through a symlink to a location outside the root
- **THEN** the import is rejected and no content is read from the escape target

### Requirement: Local import target must be a git repository

A local import target SHALL be validated as a git repository (a working tree with `.git`, or a bare repository) before any content acquisition. Non-git directories SHALL be rejected with an actionable error. Acquisition SHALL use git-native cloning from the local path (not raw file copy), yielding the same bare-mirror copy shape as forge imports.

#### Scenario: Non-git directory rejected
- **WHEN** an operator selects a directory under the root that is not a git repository
- **THEN** the import fails with an error naming the requirement, and no Repo row is created

#### Scenario: Local import yields the standard copy
- **WHEN** a valid local git repository is imported
- **THEN** the repo-store contains a bare mirror for the new Repo identical in shape to a forge-imported copy

### Requirement: Locally imported Repos record their source and stay outside forge delivery

A locally imported Repo SHALL record the source path as its git source, SHALL be usable for task creation like any Repo with a ready copy, and SHALL NOT be treated as connected to any forge: forge-side delivery actions (opening PRs/MRs) are unavailable for it, while in-sandbox git operations against the recorded local source remain governed by the standard delivery configuration.

#### Scenario: Local repo runs tasks
- **WHEN** a task is created for a locally imported Repo with a ready copy
- **THEN** the workspace materializes from the copy and the agent can work in it normally

#### Scenario: No forge delivery offered
- **WHEN** the console or API reads delivery options for a locally imported Repo
- **THEN** forge PR/MR delivery is not offered for it

### Requirement: Console exposes local import as a third mode when enabled

When local import is enabled, the console import surface SHALL offer a local-path mode alongside the forge picker and URL modes, accepting a path (relative to or contained in the allowlist root) and reporting validation and acquisition results. When disabled, the mode SHALL be absent or explicitly marked unavailable with the enabling configuration named.

#### Scenario: Third mode appears when enabled
- **WHEN** `CAP_LOCAL_IMPORT_ROOT` is configured and an operator opens the import dialog
- **THEN** a local-path import mode is offered alongside the existing modes

#### Scenario: Mode absent when disabled
- **WHEN** the feature is disabled and an operator opens the import dialog
- **THEN** the local-path mode is not offered as an actionable choice

