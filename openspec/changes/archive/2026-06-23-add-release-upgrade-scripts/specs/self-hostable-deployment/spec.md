## ADDED Requirements

### Requirement: Manual upgrade is scriptized and stages BOTH the api and sandbox images

The project SHALL provide a manual upgrade script that, for a target version, stages BOTH the
`cap-api` and `cap-aio-sandbox` images at that version and recreates the api — with NO option to
upgrade only one. The script SHALL pin the deployment's `CAP_VERSION` (backing up the env file
first), pull BOTH images BEFORE recreating (so a failed pull leaves the prior version running), and
target the running compose topology (project + compose file parametrizable, defaulting to the
resident production stack). A manual upgrade SHALL NOT be able to leave the sandbox image unstaged —
the exact failure that makes every new task's sandbox provision return `404 no such image`.

#### Scenario: Upgrade stages both images, no single-service door

- **WHEN** an operator runs the upgrade script for a version
- **THEN** both `cap-api` and `cap-aio-sandbox` at that version are pulled and the api is recreated, and there is no flag or path that pulls/recreates only one

#### Scenario: Pin and backup before recreate

- **WHEN** the upgrade script runs
- **THEN** it backs up the env file, atomically pins `CAP_VERSION` to the target (preserving other lines), and pulls before `up` so a failed pull leaves the prior version running

### Requirement: Upgrade verifies the version and runs a sandbox provision smoke

After recreating, the upgrade script SHALL verify the served `/version` equals the target AND SHALL
run a provision smoke — create a throwaway task, confirm it reaches `running` (the sandbox
provisioned successfully), then stop it — so a missing or unrunnable sandbox image is detected at
upgrade time rather than by a user creating a task later. When the smoke cannot run (no session
credential / repo available) it SHALL be skipped with a loud warning rather than failing the upgrade
(the force-both pull remains the hard guarantee).

#### Scenario: Provision smoke catches a bad sandbox image at upgrade time

- **WHEN** the upgrade script finishes recreating and creates a smoke task
- **THEN** the task reaching `running` confirms the sandbox image provisions and the task is stopped; a failure to reach `running` surfaces the problem at upgrade time

#### Scenario: Smoke skipped without credentials

- **WHEN** no session credential / repo id is available for the smoke
- **THEN** the smoke is skipped with a warning and the upgrade still completes
