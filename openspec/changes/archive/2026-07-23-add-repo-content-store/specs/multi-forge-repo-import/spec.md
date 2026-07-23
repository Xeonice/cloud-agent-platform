# multi-forge-repo-import Specification (delta)

## ADDED Requirements

### Requirement: Forge and URL imports acquire the content copy at import time

Forge-picker and URL import flows SHALL trigger content-copy acquisition (per `repo-content-store`) as part of the import, using the operator's connected forge credential for the clone where one exists. Import completion SHALL mean both the Repo metadata row and a ready content copy exist. When acquisition fails, the import SHALL surface the typed failure and SHALL NOT leave a Repo that silently cannot start tasks without indicating its copy is missing.

#### Scenario: Import completes with a ready copy
- **WHEN** an operator imports a repository via the forge picker or by URL and acquisition succeeds
- **THEN** the new Repo's copy status is ready and a task can be created against it immediately

#### Scenario: Acquisition failure is visible on the imported repo
- **WHEN** metadata validation succeeds but content acquisition fails
- **THEN** the operator sees the failure cause and the Repo (if created) shows a non-ready copy status with a retry path
