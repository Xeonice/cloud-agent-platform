## MODIFIED Requirements

### Requirement: Web and API are independently addressable, and are NOT independently versioned

The web app SHALL reach the api exclusively through env-configurable `API_BASE_URL`
and `WS_URL` values, which SHALL be allowed to point at a different origin than the
web app, and the system SHALL NOT assume web and api share an origin.

**That is a statement about LOCATION, and it SHALL NOT be read as one about
VERSION.** The two are separable and were previously stated under one phrase —
"independently deployable" — which reads as licence for the two sides to run
different builds. They may sit on different hosts, behind different proxies, in
different clouds. They ship from one release.

A deployment path that publishes one side without the other SHALL NOT exist. Where
one did, it produced exactly the failure this separation is meant to prevent: a
console built from the default branch, an api pinned to a release many commits
behind it, and a wire shape that had moved in between.

#### Scenario: Web reads API location from environment

- **WHEN** the web app resolves where to send REST and WebSocket traffic
- **THEN** it reads `API_BASE_URL` and `WS_URL` from environment configuration rather than a hardcoded origin

#### Scenario: Cross-origin api is supported

- **WHEN** `API_BASE_URL` and `WS_URL` point to a host different from the web app's own origin
- **THEN** the web app functions correctly against that cross-origin api without requiring same-origin

#### Scenario: Different origins do not imply different versions

- **WHEN** the console and the api are deployed to different origins
- **THEN** they still carry the same release version, because the release publishes
  both and no other path publishes either
