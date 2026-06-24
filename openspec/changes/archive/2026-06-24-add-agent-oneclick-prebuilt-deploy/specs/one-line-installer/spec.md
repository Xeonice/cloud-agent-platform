## MODIFIED Requirements

### Requirement: Environment preflight and honest failure

The script SHALL verify prerequisites before mutating the system and SHALL exit
with a clear message when they are unmet. The preflight SHALL verify EVERY tool the
script invokes — including `make`, which the script calls to perform the bring-up —
so a host missing a required tool is stopped BEFORE cloning rather than failing
mid-run after the repository has been cloned.

#### Scenario: Missing Docker

- **WHEN** the script runs and Docker or `docker.sock` is not available
- **THEN** it stops before cloning/bootstrapping and prints a clear message
  stating the unmet prerequisite

#### Scenario: Missing make

- **WHEN** the script runs on a host without `make` (e.g. a fresh Ubuntu / WSL)
- **THEN** it stops before cloning and prints a clear message that `make` is required,
  rather than cloning the repository and then failing when it invokes `make`

#### Scenario: Apple Silicon guidance

- **WHEN** the script runs on an arm64 host
- **THEN** it warns that the first `make up` is slow under amd64 emulation and
  points at the faster control-plane-only path (`make up-cp`)
