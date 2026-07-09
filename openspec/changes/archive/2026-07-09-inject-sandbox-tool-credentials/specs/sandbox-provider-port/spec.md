## ADDED Requirements

### Requirement: Provisioning supports provider-neutral image parameter setup

The sandbox provider orchestration SHALL support a provider-neutral image parameter setup step that runs after workspace materialization and before agent runtime launch. The setup step SHALL use the selected provider's command executor and SHALL NOT require provider packages to import database services or secret storage. Providers SHALL receive only command-ready setup actions or non-secret descriptors from the host harness.

#### Scenario: Image parameter setup runs before runtime launch

- **WHEN** a task is provisioned with selected image parameters
- **THEN** CAP runs the image parameter setup step before launching the selected agent runtime
- **AND** tools invoked by the agent can read `/home/gem/.cap/image-env` during the first turn

#### Scenario: Provider packages stay database-free

- **WHEN** AIO or BoxLite performs image parameter setup
- **THEN** the provider executes commands supplied by the host harness through its command executor
- **AND** the provider does not query Prisma or decrypt secret parameters itself

#### Scenario: Missing optional image parameters do not block provider selection

- **WHEN** no image parameters are configured for the selected environment
- **THEN** provider selection and sandbox provisioning can continue
- **AND** no empty or placeholder secret is materialized
