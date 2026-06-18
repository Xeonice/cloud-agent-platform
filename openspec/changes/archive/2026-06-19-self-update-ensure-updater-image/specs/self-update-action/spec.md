## ADDED Requirements

### Requirement: The updater image is ensured present before the updater container is created
The detached updater container is created from a fixed, server-side updater image (default `docker:27-cli`, overridable via `SELF_UPDATE_UPDATER_IMAGE`). Because container creation does NOT pull a missing image, an enabled self-update SHALL ensure that updater image is present locally BEFORE creating the updater container: it SHALL inspect the image first and pull it ONLY when absent. A host that has never staged the updater image (e.g. a fresh deploy whose image cache is empty) SHALL self-heal by pulling it, rather than failing the whole request with the Docker daemon's "no such image" error. A host that already has the image staged SHALL NOT incur a pull (the steady-state path stays offline-friendly).

This applies only to the updater helper image; the cap GHCR target images remain pulled by the updater's own pull-then-recreate step and are unaffected.

#### Scenario: A fresh host with no updater image self-heals
- **WHEN** an enabled, admin-confirmed, valid self-update is invoked on a host whose updater image is not present locally
- **THEN** the launcher pulls the updater image first and then creates the updater container, rather than the request failing with a `no such image` 404

#### Scenario: A host that already staged the updater image does not re-pull
- **WHEN** an enabled self-update is invoked on a host whose updater image is already present locally
- **THEN** the launcher creates the updater container directly without pulling the updater image again
