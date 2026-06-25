## MODIFIED Requirements

### Requirement: Multi-policy retention cleaner reaps stopped retained containers
The retention cleaner SHALL operate through a provider-neutral retained-sandbox store/facade instead of assuming every retained sandbox is a local Docker `cap-aio-*` container. The local AIO implementation SHALL continue to reap stopped retained `cap-aio-*` containers under the existing age and free-disk policies, while future providers MAY expose equivalent retained artifacts through the same store seam.

#### Scenario: Retention cleaner uses provider-neutral store
- **WHEN** the retention cleaner sweeps retained sandboxes
- **THEN** it obtains retention candidates and removal operations through the retained-sandbox store/facade seam
- **AND** it does not depend directly on the local AIO provider class

#### Scenario: Local AIO retention behavior is preserved
- **WHEN** the selected retained-sandbox store is backed by local AIO containers
- **THEN** stopped `cap-aio-*` containers are still removed by age or low-free-disk policies
- **AND** running containers are still never removed by the cleaner

#### Scenario: Retention removal remains best-effort
- **WHEN** removing a retained sandbox fails for a provider-specific reason
- **THEN** the cleaner records/logs the failure and continues sweeping other eligible retained sandboxes
