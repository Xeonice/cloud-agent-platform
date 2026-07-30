## ADDED Requirements

### Requirement: A production console SHALL only be published by a release

The hosted console SHALL be published by the release workflow and by nothing else.
A branch-tracking deployment that publishes a production console on merge SHALL be
disabled, because it is a second deployment path that bypasses the version the
release coordinates.

Preview deployments for a pull request SHALL keep working. A preview is not
production and carries no version claim.

The release SHALL pass the release version to the console build, so the console
knows which release it belongs to by the same value the images carry.

A release that cannot publish the console SHALL fail visibly rather than publish
the images alone. Half a release is the state this requirement exists to prevent.

#### Scenario: A merge does not publish a console

- **WHEN** a commit lands on the default branch
- **THEN** no production console is published

#### Scenario: A release publishes the console with the images

- **WHEN** a release is published
- **THEN** the console is deployed to production carrying that release's version,
  after the image set has verified

#### Scenario: A pull request still gets a preview

- **WHEN** a pull request is opened or updated
- **THEN** a preview deployment is still produced, and it makes no version claim

### Requirement: The console SHALL present its build identity and the api SHALL refuse a mismatch

The console SHALL send its baked build identity to the api on both transports it
uses — the REST path and the WebSocket handshake — and the api SHALL compare that
identity against its own release version.

A mismatch SHALL be refused rather than served. Under the deployment invariant this
capability establishes, the two sides move together or not at all, so a mismatch is
a deployment defect and not a configuration the system supports. Serving through
one produces the failure this requirement exists to prevent: a console reading an
empty list because the api it is talking to still speaks a shape the console has
stopped tolerating.

Introducing the refusal SHALL be ordered so that the api learns to read the identity
before the console begins sending it, and the absent case SHALL only become a
refusal once a console that sends it has shipped. An api that refuses a field no
deployed console sends yet refuses everything.

The added identity SHALL be additive on both transports, so an api that does not
yet read it ignores the field rather than rejecting the message.

#### Scenario: Matching identities are served

- **WHEN** a console whose build identity equals the api's release version makes a
  request or opens a connection
- **THEN** it is served normally

#### Scenario: A mismatched console is refused

- **WHEN** a console presents a build identity that differs from the api's release
  version
- **THEN** the request or connection is refused, and the refusal names both
  versions so an operator can see which side is behind

#### Scenario: An api that does not read the identity is not broken by it

- **WHEN** a console that sends the identity talks to an api built before the api
  read it
- **THEN** the api ignores the added header and the added handshake parameter
  rather than rejecting the request or the connection

## MODIFIED Requirements

### Requirement: The web console carries a baked build id

The web build SHALL bake a build identifier (`VITE_BUILD_ID`, a Vite compile-time
value) into the console bundle, surfaced through the existing web config module, so
the running console knows its own build.

A build performed OUTSIDE a deployment — a developer's machine, a test run — SHALL
default to a sentinel and SHALL keep working, because a local console must not
require a release to exist.

**A DEPLOYED console SHALL NOT present a sentinel.** The sentinel was previously
permitted everywhere, on the reasoning that reporting something is better than
failing; that was true only while nothing read the value. It is also precisely what
allowed one deployment path to go unplumbed for its entire life while looking
identical to a laptop build — the same build id function returning a real version
from the image and the literal `"dev"` from the hosted console, with no caller to
notice. Where the identity is load-bearing, a sentinel is not a degraded answer but
the absence of one.

#### Scenario: Web build id is baked at build time

- **WHEN** the web app is built with a `VITE_BUILD_ID` provided
- **THEN** the built console exposes that build id through its config module

#### Scenario: A local build keeps working without a release

- **WHEN** the web app is built with no `VITE_BUILD_ID` — a developer machine or a
  test run
- **THEN** it reports a sentinel and functions

#### Scenario: A sentinel from a deployed console is refused

- **WHEN** a console presents the sentinel as its build identity to an api
- **THEN** it is refused exactly as a mismatch is, because a deployment that did
  not receive a version is a deployment whose version cannot be asserted

### Requirement: A GitHub-Release-triggered workflow publishes a matched, versioned image set to GHCR

The repository SHALL define a CI workflow triggered on `release: published` and
`workflow_dispatch` that builds and pushes a matched set of
`ghcr.io/<owner>/cap-api`, `cap-web`, `cap-aio-sandbox`, and
`cap-boxlite-sandbox`, all tagged with one `vX.Y.Z` release version and built
with `CAP_VERSION`/`GIT_SHA`/`BUILD_TIME`. The final `cap-api` runtime image SHALL
contain the Git executable required by production remote-ref resolution. Before
the API image is published, the workflow SHALL execute a container-level
dependency smoke against the built artifact, including `git --version`, and
SHALL fail without pushing a known-bad API image when the command is absent or
not executable. The workflow SHALL use the built-in token with `packages: write`
and make published packages publicly pullable. Merely committing the workflow
SHALL remain inert until a Release is published.

**The same workflow SHALL also publish the hosted console**, so that one release
moves every deployed surface. The image set alone is not the release: a console
published on a different cadence is a second version of the product, and the
matched image set proves nothing about the console an operator is looking at.

#### Scenario: Publishing a Release builds and pushes the matched image set

- **WHEN** a GitHub Release `vX.Y.Z` is published
- **THEN** the workflow builds and pushes all four matched CAP images with version metadata
- **AND** the published packages are publicly pullable
- **AND** the hosted console is deployed at the same version
