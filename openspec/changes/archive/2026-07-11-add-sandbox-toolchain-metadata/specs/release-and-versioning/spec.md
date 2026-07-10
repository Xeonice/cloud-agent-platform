## ADDED Requirements

### Requirement: Official sandbox releases publish matching toolchain metadata

The release workflow SHALL build the official AIO and BoxLite sandbox images with the same exact sandbox, Codex, Claude Code, and OpenSpec version inputs. Release verification SHALL read the required metadata from both published images and their packaged offline assets and SHALL fail when metadata is missing, invalid, mismatched between distribution forms, or does not identify the target CAP release.

#### Scenario: Official images share one toolchain contract
- **WHEN** a CAP release builds the official AIO and BoxLite sandbox images
- **THEN** both images contain schema-version-1 metadata with identical official dependency versions
- **AND** each metadata document identifies the target CAP release as its sandbox version

#### Scenario: Offline assets preserve image metadata
- **WHEN** release CI packages the AIO Docker archive and BoxLite OCI/rootfs assets from the published images
- **THEN** the metadata contained in each packaged asset equals the corresponding published image metadata

#### Scenario: Release verification rejects metadata drift
- **WHEN** an official sandbox image or packaged asset is missing metadata or contains different dependency versions from its sibling artifact
- **THEN** the release verification fails and does not report the sandbox artifact set complete
