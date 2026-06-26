## ADDED Requirements

### Requirement: Release docs distinguish platform-aware source install from AIO prebuilt package

The release and self-host documentation SHALL distinguish the platform-aware source installer from the source-free prebuilt run package. The source installer SHALL document macOS defaulting to BoxLite and Linux defaulting to AIO. The prebuilt run package SHALL continue to document its AIO/amd64 constraints unless a BoxLite-backed source-free package is implemented. Both paths SHALL document that api/web host ports bind to `0.0.0.0` by default while public DNS, TLS, reverse proxy, OAuth callback, cookie scope, and firewall setup remain operator-owned.

#### Scenario: Release run-package caveats remain honest

- **WHEN** a user reads the source-free run-package docs
- **THEN** the docs state whether the package is AIO/amd64-only or BoxLite-capable for that release
- **AND** they do not imply macOS BoxLite support for a package that cannot run it

#### Scenario: Source install docs show platform defaults

- **WHEN** a user reads the source installer docs
- **THEN** macOS is documented as defaulting to BoxLite and Linux as defaulting to AIO

#### Scenario: Public exposure is documented as operator configuration

- **WHEN** a user reads install or release docs
- **THEN** all-interface host binding is documented separately from public DNS/TLS/proxy/OAuth/cookie/firewall configuration
