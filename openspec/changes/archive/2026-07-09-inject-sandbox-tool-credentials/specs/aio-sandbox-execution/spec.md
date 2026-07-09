## ADDED Requirements

### Requirement: AIO provisions selected image parameters and clears them before retention

The AIO sandbox provisioning path SHALL run the provider-neutral image parameter setup step after the workspace is materialized and before the selected agent runtime is launched. For retained AIO containers, teardown SHALL attempt to remove the CAP image parameter env file before stopping the container, alongside existing runtime credential trimming. A cleanup failure SHALL NOT block container stop or task settlement.

#### Scenario: AIO task receives image parameters before agent launch

- **WHEN** an AIO-backed task uses a sandbox environment with image parameters
- **THEN** AIO provisioning writes `/home/gem/.cap/image-env` inside the task container before the agent runtime launch command runs
- **AND** the workspace and agent runtime setup remain otherwise unchanged

#### Scenario: AIO teardown clears materialized image parameters

- **WHEN** an AIO-backed task is being stopped and the container will be retained
- **THEN** teardown attempts to remove `/home/gem/.cap/image-env` before stopping the container
- **AND** the retained stopped container does not intentionally keep usable image parameter files

#### Scenario: AIO setup output does not leak secret parameters

- **WHEN** AIO image parameter setup fails
- **THEN** logged setup output is scrubbed or bounded so plaintext secret parameters are not emitted
- **AND** the failure message contains non-secret task/provider context only
