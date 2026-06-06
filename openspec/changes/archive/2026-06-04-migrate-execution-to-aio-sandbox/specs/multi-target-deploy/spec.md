## MODIFIED Requirements

### Requirement: API target is Fly.io or docker-compose
The `apps/api` orchestrator process MAY be hosted on Fly.io via a `fly.toml` or via `docker-compose` via a `docker-compose.yml`, both running the same NestJS WebSocket + PTY orchestrator. However, PER-TASK EXECUTION SHALL require the docker-compose SELF-HOST topology and Fly SHALL NOT be an execution target: Firecracker microVMs expose no host docker socket, so Docker-out-of-Docker (DooD) sibling provisioning of per-task AIO sandboxes is impossible on Fly. When the orchestrator runs on Fly, it MAY host the control plane but SHALL NOT execute tasks.

#### Scenario: API can be hosted on either target, but only compose executes tasks
- **WHEN** the deployment configuration for `apps/api` is inspected
- **THEN** a `fly.toml` and a `docker-compose.yml` both exist that run the api orchestrator
- **AND** both target the same NestJS WebSocket + PTY orchestrator process

#### Scenario: Fly is not an execution target
- **WHEN** the orchestrator is hosted on Fly.io
- **THEN** it does not provision or execute per-task AIO sandboxes, because Firecracker microVMs expose no host docker socket for DooD sibling provisioning

#### Scenario: Per-task execution requires the compose self-host topology
- **WHEN** a task must be executed
- **THEN** execution occurs only under the docker-compose self-host topology that provides DooD sandbox provisioning

## ADDED Requirements

### Requirement: DooD docker-compose execution topology with docker.sock and cap-net
The docker-compose self-host topology SHALL mount the host docker socket `/var/run/docker.sock` into the `api` service so the orchestrator can provision sibling sandbox containers via Docker-out-of-Docker, and SHALL define a user-defined network `cap-net` (the default bridge has no container-name DNS) joined by the `api` service. Each per-task AIO sandbox SHALL be attached to `cap-net`, SHALL be reachable by container name, and SHALL publish NO host port — making NETWORK ISOLATION the execution security boundary. It SHALL be documented that mounting `/var/run/docker.sock` into `api` is host-root-equivalent and is accepted only for single-user self-host.

#### Scenario: docker.sock is mounted into the api service
- **WHEN** the `docker-compose.yml` is inspected
- **THEN** the `api` service mounts `/var/run/docker.sock` so it can provision sibling sandbox containers via DooD

#### Scenario: cap-net is defined and joined for container-name addressing
- **WHEN** the `docker-compose.yml` is inspected
- **THEN** a user-defined network `cap-net` is defined and the `api` service joins it
- **AND** per-task AIO sandboxes attach to `cap-net` and are dialed by container name rather than by host port

#### Scenario: Sandboxes publish no host port
- **WHEN** a per-task AIO sandbox container is provisioned under the compose topology
- **THEN** it publishes no host port and is reachable only on `cap-net` by the orchestrator
- **AND** network isolation is the execution security boundary

#### Scenario: Host-root-equivalent risk is documented
- **WHEN** the compose self-host topology documentation is inspected
- **THEN** it states that mounting `/var/run/docker.sock` into `api` grants host-root-equivalent access and is accepted only for single-user self-host
