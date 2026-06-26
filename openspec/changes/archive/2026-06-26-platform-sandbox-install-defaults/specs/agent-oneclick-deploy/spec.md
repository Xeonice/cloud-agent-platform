## MODIFIED Requirements

### Requirement: Architecture gate for amd64-only prebuilt images

The prebuilt quick-deploy script SHALL verify the host architecture is amd64/x86_64 before pulling, because the published prebuilt image set remains AIO-oriented and amd64-only unless a BoxLite-backed source-free run package is explicitly added. On a non-amd64 host (including macOS on Apple Silicon) it SHALL stop with a clear message that directs the user to the source installer/local bring-up path, whose platform auto-selection defaults macOS to BoxLite, instead of failing later with an opaque manifest error.

#### Scenario: arm64 host is stopped early with source-installer guidance

- **WHEN** the prebuilt quick-deploy script runs on an arm64 host
- **THEN** it stops before pulling and prints that the prebuilt images are amd64/AIO-oriented
- **AND** it directs the user to the source installer or `make up`, which will select BoxLite by default on macOS

#### Scenario: amd64 host passes the gate

- **WHEN** the prebuilt quick-deploy script runs on an x86_64 host
- **THEN** the architecture gate passes and the prebuilt AIO bring-up proceeds

## ADDED Requirements

### Requirement: Prebuilt quick-deploy does not override platform-aware source defaults

The prebuilt quick-deploy path SHALL remain a separate source-free path from the source installer. Its amd64/AIO constraints SHALL NOT change the source installer defaults: macOS source installs default to BoxLite and Linux source installs default to AIO.

#### Scenario: Source installer defaults remain independent

- **WHEN** quick-deploy is present in the repository and on the site
- **THEN** the source installer still applies macOS BoxLite and Linux AIO auto-selection
