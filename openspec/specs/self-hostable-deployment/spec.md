# self-hostable-deployment Specification

## Purpose
A stranger can stand up a complete, production-capable cap instance from the docker-compose stack: the web console ships as a self-contained Node-server service (behind the `web` profile) alongside api+postgres, every deployment-specific value is env-overridable with no maintainer-hardcoded values, an OAuth-first self-host boots without a legacy token, and a setup guide documents the GitHub-OAuth-app + allowlist + domain steps. (created by archiving change self-hostable-stack)
## Requirements
### Requirement: The compose stack is a complete self-hostable unit including the frontend
The docker-compose stack SHALL bring up a COMPLETE cap instance — the web console, the api orchestrator, and Postgres — so a stranger who clones the repo can stand up a usable cap with a single documented compose bring-up WITHOUT deploying the frontend separately. The web console SHALL run as a self-contained Node server service (the Nitro `node-server` build output, `.output/server/index.mjs`) joined to the stack's default network, reaching the api by its env-configured URLs. The in-compose web service SHALL be gated behind a `web` compose profile (consistent with the existing `observability`/`grafana`/`proxy` profiles), enabled by the documented self-host bring-up (e.g. `COMPOSE_PROFILES=web`), so a deploy that serves the console elsewhere can leave it off. The existing Vercel deployment path for the web app SHALL remain available (selectable at build time), so this ADDS a compose-hosted web target rather than removing the Vercel one.

#### Scenario: The documented bring-up yields a complete cap with a web console
- **WHEN** a stranger with a configured env runs the documented self-host bring-up (the `web` profile enabled, e.g. `COMPOSE_PROFILES=web docker compose up`) on a fresh clone
- **THEN** the stack starts the web console, the api, and Postgres, and the web console is reachable and talks to the api — no separate frontend deployment is required

#### Scenario: The in-compose web service is profile-gated
- **WHEN** the compose stack is brought up WITHOUT the `web` profile
- **THEN** the in-compose web service is neither built nor run (api + Postgres still come up), so a deploy that serves the console elsewhere is unaffected

#### Scenario: The web console runs as a self-contained Node server
- **WHEN** the web service in the compose stack is inspected
- **THEN** it runs the Nitro `node-server` output (`.output/server/index.mjs`) as a long-running Node process, not a Vercel-only artifact

#### Scenario: The Vercel web path is preserved
- **WHEN** the web app is built for Vercel (the maintainer's deploy)
- **THEN** the Vercel preset is still selectable at build time and the Vercel deployment continues to work, unaffected by the added compose-hosted web target

### Requirement: Every deployment-specific value is env-overridable with no maintainer-hardcoded values
The deployment SHALL NOT hardcode any value specific to the maintainer's own environment that a self-hoster cannot override. The database connection (`DATABASE_URL`) SHALL be env-overridable (the compose-internal default is permitted, but an external DB / different credentials SHALL be honored when set). The public URLs (api base, ws url, web origin, cookie scope) and the GitHub OAuth app credentials and the operator allowlist SHALL all be env-driven. No maintainer-specific domain (e.g. a personal production hostname) SHALL be baked into the shipped configuration.

#### Scenario: DATABASE_URL can point at an external database
- **WHEN** a self-hoster sets `DATABASE_URL` to an external Postgres
- **THEN** the api connects to that database, while leaving the value unset uses the compose-internal Postgres default

#### Scenario: No maintainer-specific domain is baked in
- **WHEN** the shipped compose file and configuration are inspected
- **THEN** they contain no hardcoded maintainer-specific production hostname that a self-hoster cannot override (the prior `grafana.douglasdong.com` reference is removed)

#### Scenario: Public URLs, OAuth credentials, and allowlist are all env-driven
- **WHEN** a self-hoster configures their own domains, GitHub OAuth app, and allowlist via environment
- **THEN** the instance uses those values with no source edit required

### Requirement: An OAuth-first self-host boots without a legacy operator token
A production, OAuth-first self-host SHALL NOT require the legacy `AUTH_TOKEN` to be set: when the legacy operator-token path is not enabled, the api SHALL boot with GitHub-OAuth configuration alone. The existing local-dev bring-up that generates a legacy token and enables the legacy path SHALL remain unchanged.

#### Scenario: OAuth-only instance boots with no legacy token
- **WHEN** the api starts with GitHub-OAuth configured and the legacy operator-token path NOT enabled, and no `AUTH_TOKEN` set
- **THEN** the api boots successfully and authenticates operators via GitHub OAuth, without requiring a legacy token

#### Scenario: Local-dev legacy-token path is unchanged
- **WHEN** the one-command local dev bring-up generates a legacy token and enables the legacy path
- **THEN** local operators can still authenticate with the generated token exactly as before

### Requirement: A self-host setup guide documents the human configuration steps
The project SHALL provide an operator-facing self-host setup guide, discoverable from the README, that documents the steps a self-hoster must perform by hand: creating a GitHub OAuth app (client id/secret and the callback URL derived from their api origin), setting the operator allowlist, configuring the public domains and the session cookie scope (covering both same-origin and cross-subdomain deploys), generating the required secrets, and bringing up the compose stack. The guide SHALL make explicit the values most likely to be misconfigured (web origin / cookie domain for cross-origin deploys).

#### Scenario: Setup guide exists and is discoverable
- **WHEN** the repository documentation is inspected
- **THEN** a self-host setup guide exists and is linked from the README

#### Scenario: Guide covers the OAuth app + allowlist + domain steps
- **WHEN** a self-hoster follows the guide
- **THEN** it walks them through creating a GitHub OAuth app (including the callback URL), setting the allowlist, configuring the public domains + cookie scope, generating secrets, and running `docker compose up`

### Requirement: Manual upgrade is scriptized and stages BOTH the api and sandbox images

The project SHALL provide a manual upgrade script that, for a target version, stages BOTH the
`cap-api` and `cap-aio-sandbox` images at that version and recreates the api — with NO option to
upgrade only one. The script SHALL pin the deployment's `CAP_VERSION` (backing up the env file
first), pull BOTH images BEFORE recreating (so a failed pull leaves the prior version running), and
target the running compose topology (project + compose file parametrizable, defaulting to the
resident production stack). A manual upgrade SHALL NOT be able to leave the sandbox image unstaged —
the exact failure that makes every new task's sandbox provision return `404 no such image`.

#### Scenario: Upgrade stages both images, no single-service door

- **WHEN** an operator runs the upgrade script for a version
- **THEN** both `cap-api` and `cap-aio-sandbox` at that version are pulled and the api is recreated, and there is no flag or path that pulls/recreates only one

#### Scenario: Pin and backup before recreate

- **WHEN** the upgrade script runs
- **THEN** it backs up the env file, atomically pins `CAP_VERSION` to the target (preserving other lines), and pulls before `up` so a failed pull leaves the prior version running

### Requirement: Upgrade verifies the version and runs a sandbox provision smoke

After recreating, the upgrade script SHALL verify the served `/version` equals the target AND SHALL
run a provision smoke — create a throwaway task, confirm it reaches `running` (the sandbox
provisioned successfully), then stop it — so a missing or unrunnable sandbox image is detected at
upgrade time rather than by a user creating a task later. When the smoke cannot run (no session
credential / repo available) it SHALL be skipped with a loud warning rather than failing the upgrade
(the force-both pull remains the hard guarantee).

#### Scenario: Provision smoke catches a bad sandbox image at upgrade time

- **WHEN** the upgrade script finishes recreating and creates a smoke task
- **THEN** the task reaching `running` confirms the sandbox image provisions and the task is stopped; a failure to reach `running` surfaces the problem at upgrade time

#### Scenario: Smoke skipped without credentials

- **WHEN** no session credential / repo id is available for the smoke
- **THEN** the smoke is skipped with a warning and the upgrade still completes

### Requirement: Custom sandbox image documentation covers registry operations

The project SHALL document how operators build, tag, push, register, validate,
and maintain custom AIO and BoxLite sandbox images using pinned image
references. The documentation SHALL make registry responsibilities explicit:
CAP does not store registry credentials, and the Docker host or BoxLite host
must be able to pull the image before CAP validation can pass. The documentation
SHALL call out GHCR package write permissions and private package visibility
when GHCR is used.

#### Scenario: GHCR package permission requirements are documented

- **WHEN** an operator follows the custom image guide using GHCR
- **THEN** the guide tells them that pushing a custom package requires package
  write permission such as `write:packages`
- **AND** it tells them that the provider host must be able to pull the package
  with appropriate visibility or registry authentication

#### Scenario: Private registry reachability is documented

- **WHEN** an operator uses a private or internal registry for a custom image
- **THEN** the guide states that CAP stores only the non-secret image reference
- **AND** the Docker host or BoxLite host must be configured separately to pull
  that image before validation can pass

### Requirement: BoxLite deployment-default custom rootfs path is documented

The self-host documentation SHALL describe the advanced BoxLite
deployment-default customization path for operators who need a same-host custom
default without a managed image-library selection. The documented path SHALL
extend the official BoxLite sandbox image for the running CAP version, export a
Linux OCI rootfs layout for the BoxLite host architecture, configure
`BOXLITE_ROOTFS_PATH`, restart the API, and run a create/start/exec/delete probe.
The documentation SHALL state that this rootfs path is a deployment-level
default, not a managed image-library source.

#### Scenario: Operator configures a BoxLite rootfs deployment default

- **WHEN** an operator follows the advanced BoxLite rootfs guide
- **THEN** they can build or export an OCI rootfs layout, set
  `BOXLITE_ROOTFS_PATH`, restart the API, and verify BoxLite can start and exec
  from that rootfs
- **AND** new tasks without a managed image selection use that deployment-level
  default

#### Scenario: Rootfs path is not presented as a managed image source

- **WHEN** the self-host documentation explains BoxLite rootfs customization
- **THEN** it states that rootfs is not registered in `/images`
- **AND** managed image-library customization remains based on pinned registry
  image references

### Requirement: Custom sandbox image templates build without avoidable warnings

The checked-in custom sandbox image templates SHALL use valid base image
references when linted or built with the documented arguments, SHALL preserve
the official task user and `/home/gem/workspace` working directory, and SHALL
avoid avoidable BuildKit warnings such as an empty `FROM` image caused by an
unset build argument.

#### Scenario: Templates keep workspace and task user

- **WHEN** the AIO and BoxLite custom image templates are inspected
- **THEN** they preserve the `gem` task user and `/home/gem/workspace` working
  directory

#### Scenario: Templates avoid empty FROM warnings

- **WHEN** an operator builds the templates using the documented command
- **THEN** BuildKit does not warn that the `FROM` image is empty or invalid
  because of an unset CAP version argument

