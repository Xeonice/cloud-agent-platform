## ADDED Requirements

### Requirement: Release install docs enumerate external dependencies

The release and self-host documentation SHALL enumerate external dependencies by phase: install-time required dependencies, selected-provider dependencies, and task-time optional dependencies. The docs SHALL make clear which missing dependencies block install and which only affect later task execution or optional features.

#### Scenario: Docs separate install-time dependencies

- **WHEN** a user reads the release-image install documentation
- **THEN** required install-time dependencies include shell tooling, Docker/Compose/socket, release asset endpoints, GHCR images, Docker Hub Postgres image, and selected provider readiness
- **AND** selected-provider dependencies include BoxLite endpoint/token/protocol/image plus native create/start/exec runtime tool checks when BoxLite is selected
- **AND** optional task-time dependencies such as GitHub/GitLab/Gitee repo access, optional GitHub validation token, OpenAI or Claude auth, package registries, public DNS/TLS/proxy, external Postgres, and SMTP are listed separately

#### Scenario: Docs describe Docker install behavior

- **WHEN** a user reads the installer documentation
- **THEN** it states that Docker is installed only when absent
- **AND** it states that a missing Compose plugin is installed without reinstalling Docker Engine
- **AND** it states that an existing usable Docker installation is left untouched
- **AND** it states that installed-but-unreachable Docker is treated as a daemon/socket/context issue rather than a reinstall trigger
