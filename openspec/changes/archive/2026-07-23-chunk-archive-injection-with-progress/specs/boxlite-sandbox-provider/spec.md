# boxlite-sandbox-provider Specification (delta)

## ADDED Requirements

### Requirement: BoxLite archive injection chunks uploads under the daemon body limit with verified reassembly

BoxLite archive workspace injection SHALL split the repo-copy tar stream into parts no larger than a configured part size (default 1.5MB, overridable via `CAP_BOXLITE_ARCHIVE_PART_BYTES`) chosen to stay under the daemon's request-body limit (2MB observed on BoxLite serve 0.9.5), upload each part in order through the existing file-upload contract into a parts directory, reassemble inside the box, and verify both total byte count and SHA-256 of the reassembled archive against values computed while streaming on the api side before extracting. A failed part upload or an integrity mismatch SHALL surface as a typed `workspace_transfer` materialization failure and SHALL NOT leave a partially assembled archive or workspace behind.

#### Scenario: Copy larger than the daemon body limit transfers successfully
- **WHEN** a BoxLite task provisions with a ready copy whose tar exceeds the daemon's single-request body limit
- **THEN** the copy reaches the box as ordered parts, reassembles with matching byte count and SHA-256, extracts, and the workspace materializes by local clone

#### Scenario: Integrity mismatch fails typed and clean
- **WHEN** the reassembled archive's checksum does not match the api-side value
- **THEN** provisioning reports a typed workspace_transfer failure and the box contains no partially assembled archive or workspace

#### Scenario: Single-request uploads beyond the limit are a guarded regression
- **WHEN** the integration fake daemon (enforcing a 2MB body limit) receives a single upload larger than the limit
- **THEN** the test suite fails that path, keeping the chunked strategy load-bearing
