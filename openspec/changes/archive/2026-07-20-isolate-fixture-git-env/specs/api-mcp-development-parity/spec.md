# api-mcp-development-parity Delta

## ADDED Requirements

### Requirement: Public-surface suites are safe to run from git hooks

Git subprocesses spawned by the public-surface verification scripts SHALL NOT inherit repository-locating `GIT_*` environment variables from their parent process. Fixture and scratch repositories created by these suites SHALL be self-contained: their git operations SHALL only ever affect the fixture's own temporary directory. Running the suites from a git hook (pre-commit, pre-push) SHALL leave the real repository's branches, refs, and index unchanged.

#### Scenario: Hook-exported git environment cannot redirect fixture operations

- **WHEN** the fixture-repository lifecycle runs in a process whose environment carries `GIT_DIR` and `GIT_INDEX_FILE` pointing at another repository
- **THEN** the fixture repository is created and committed inside its own temporary directory
- **AND** the other repository's HEAD, refs, and index are byte-identical before and after the run

#### Scenario: Real-repository collectors resolve from the working directory only

- **WHEN** the adversarial diff collectors or the pre-push base resolution spawn git with a hook-polluted parent environment
- **THEN** the spawned git resolves the repository from the provided working directory with locator variables removed
- **AND** the collected paths and resolved base match a run outside any hook

#### Scenario: Shared sanitization helper is covered by unit tests

- **WHEN** the git-environment helper is given an environment containing `GIT_*` locator variables and unrelated variables
- **THEN** every `GIT_*` key is absent from the produced environment
- **AND** unrelated variables (including `PATH`) are preserved and the input environment object is not mutated
