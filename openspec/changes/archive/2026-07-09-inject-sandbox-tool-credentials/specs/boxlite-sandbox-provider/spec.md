## ADDED Requirements

### Requirement: BoxLite provisions selected image parameters and clears them before retention

The BoxLite provider SHALL run the provider-neutral image parameter setup step after the sandbox is created, started, and workspace materialization has completed, and before the selected agent runtime is launched. If a BoxLite sandbox is retained, readoptable, or stopped without immediate deletion, teardown SHALL attempt to remove `/home/gem/.cap/image-env` through the BoxLite command executor. Cleanup failures SHALL NOT block task settlement.

#### Scenario: BoxLite task receives image parameters before agent launch

- **WHEN** a BoxLite-backed task uses a sandbox environment with image parameters
- **THEN** BoxLite provisioning writes `/home/gem/.cap/image-env` inside the task sandbox before the agent runtime launch command runs
- **AND** the selected BoxLite image source is unchanged by parameter materialization

#### Scenario: BoxLite gcode wrapper can use image parameter token

- **WHEN** a BoxLite task uses an image containing `gcode` and a wrapper that sources `/home/gem/.cap/image-env`
- **AND** the selected image has `GCODE_TOKEN` configured as a secret parameter
- **THEN** the wrapper can run `gcode` commands without a token baked into the image or manually exported by the task operator

#### Scenario: BoxLite teardown clears materialized image parameters

- **WHEN** a BoxLite-backed task is stopped, retained, or otherwise made available for readoption without deletion
- **THEN** teardown attempts to remove `/home/gem/.cap/image-env`
- **AND** provider logs do not include plaintext parameter values
