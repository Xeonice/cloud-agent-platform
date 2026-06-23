## ADDED Requirements

### Requirement: A local account's Codex credential resolves at run time

A task created by a local (password/OTP, no GitHub identity) account SHALL have its owner attributed
by the account primary key (`user.id`), so the account's OWN stored Codex credential is resolved and
injected at run time — NOT silently degraded to environment/official credentials. A GitHub account's
run-time Codex credential resolution SHALL be unchanged.

#### Scenario: Local account's saved Codex credential is injected

- **WHEN** a local account that has saved a Codex provider credential runs a task
- **THEN** the task's owner resolves by its account id and its stored Codex credential is injected (no silent degrade to env/official)

#### Scenario: GitHub account run-time credential unchanged

- **WHEN** a GitHub account runs a task
- **THEN** its Codex credential resolution is unchanged (no regression)
