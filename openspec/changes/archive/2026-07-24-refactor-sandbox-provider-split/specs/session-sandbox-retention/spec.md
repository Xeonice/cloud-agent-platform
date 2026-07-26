## MODIFIED Requirements

### Requirement: Multi-policy retention cleaner reaps stopped retained containers
The orchestrator SHALL run a periodic, unref'd retention cleaner (modeled on the existing `CodexDeviceLoginService` sweep) that operates through a provider-neutral retained-sandbox store/facade instead of assuming every retained sandbox is a local Docker `cap-aio-*` container. The local AIO implementation SHALL remove STOPPED `cap-aio-*` containers under MULTIPLE simultaneous policies, removing a container when ANY policy trips, while future providers MAY expose equivalent retained artifacts through the same store seam. Policy 1 (age): a stopped `cap-aio-*` container whose stopped age exceeds the configured retention window SHALL be removed. The retention window SHALL be read from account settings (the persisted retention-days value, default 30 days when unset). Policy 2 (free-disk high-water-mark): when host free disk drops below a configured floor, the cleaner SHALL evict OLDEST-stopped `cap-aio-*` containers FIRST until free disk recovers above the floor, even if those containers are younger than the retention window, because age alone cannot bound disk under a burst. The local AIO cleaner SHALL only ever remove containers that are STOPPED and carry the `cap-aio-*` identity — it SHALL NEVER remove a RUNNING container. The cleaner SHALL carry an in-process `isRunning` overlap guard so a slow sweep never overlaps the next tick, and the single-instance assumption SHALL be stated explicitly (no distributed lock; a multi-replica deployment would require one). A provider-specific removal failure SHALL be recorded or logged and SHALL NOT stop the cleaner from sweeping other eligible retained sandboxes.

#### Scenario: Retention cleaner uses provider-neutral store
- **WHEN** the retention cleaner sweeps retained sandboxes
- **THEN** it obtains retention candidates and removal operations through the retained-sandbox store/facade seam
- **AND** it does not depend directly on the local AIO provider class

#### Scenario: A stopped container past the retention window is reaped
- **WHEN** the cleaner sweeps and finds a stopped `cap-aio-*` container whose stopped age exceeds the configured retention window
- **THEN** the cleaner removes that container

#### Scenario: Retention window is read from settings with a 30-day default
- **WHEN** the cleaner resolves the retention window and no retention-days value is persisted in account settings
- **THEN** it uses a default of 30 days
- **AND** when a retention-days value IS persisted, the cleaner uses the persisted value instead of the default

#### Scenario: Low free disk evicts the oldest stopped containers first
- **WHEN** host free disk is below the configured high-water-mark floor and stopped `cap-aio-*` containers exist that are younger than the retention window
- **THEN** the cleaner removes the OLDEST-stopped containers first until free disk recovers above the floor, even though those containers have not yet aged out

#### Scenario: Running containers are never reaped by the cleaner
- **WHEN** the cleaner sweeps while a `cap-aio-*` container is RUNNING (an active task), regardless of its age or the free-disk level
- **THEN** the cleaner does not remove that running container

#### Scenario: Overlapping sweeps are prevented by the in-process guard
- **WHEN** a cleaner sweep is still in progress and the next scheduled tick fires
- **THEN** the second tick is skipped by the `isRunning` guard and only one sweep runs at a time

#### Scenario: Local AIO retention behavior is preserved
- **WHEN** the selected retained-sandbox store is backed by local AIO containers
- **THEN** stopped `cap-aio-*` containers are still removed by age or low-free-disk policies
- **AND** running containers are still never removed by the cleaner

#### Scenario: Retention removal remains best-effort
- **WHEN** removing a retained sandbox fails for a provider-specific reason
- **THEN** the cleaner records/logs the failure and continues sweeping other eligible retained sandboxes
