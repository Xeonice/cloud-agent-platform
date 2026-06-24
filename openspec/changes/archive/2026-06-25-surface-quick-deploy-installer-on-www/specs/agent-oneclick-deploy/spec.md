## MODIFIED Requirements

### Requirement: Scripted source-free prebuilt-image bring-up

The project SHALL provide a committed, agent-drivable bring-up script that stands up a cap
instance from the **published prebuilt images** (`ghcr.io/xeonice/cap-*:${CAP_VERSION}`) using
the source-free `docker-compose.prod.yml`, performing NO source build and requiring NO
`git clone` of the application source. The script SHALL fetch `docker-compose.prod.yml`,
`pull` the version-pinned image set, and `up` the stack, defaulting `CAP_VERSION` to a
published tag. The compose fetch base SHALL be resolved as: a repo-local `docker-compose.prod.yml`
when the script runs from a clone; otherwise an env-overridable base (`CAP_RAW_BASE`) whose
default is the publishing site when the script is the site-served copy (with an in-file fallback
in the committed source). The existing from-source paths (`make up`, `install.sh` → `make up`)
SHALL remain unchanged and SHALL NOT be a prerequisite of this path.

#### Scenario: Agent brings up cap from prebuilt images with no source build

- **WHEN** the script runs on an amd64 host with a reachable Docker engine
- **THEN** it fetches `docker-compose.prod.yml`, pulls the `ghcr.io/xeonice/cap-*:${CAP_VERSION}`
  set, and starts the stack without compiling any image from source and without cloning the
  application source tree

#### Scenario: From-source paths are unaffected

- **WHEN** the new script is added to the repository
- **THEN** `make up` and `install.sh` → `make up` continue to work exactly as before, and the
  new path does not depend on them

#### Scenario: Compose fetch base resolves by run context

- **WHEN** the script runs from a clone with a repo-local `docker-compose.prod.yml`
- **THEN** it uses the repo-local file; **AND WHEN** it runs as the site-served copy without a
  repo, it fetches `docker-compose.prod.yml` from its default base (the publishing site), which
  `CAP_RAW_BASE` overrides

### Requirement: Health verification and credential surfacing

After bringing up the stack the script SHALL wait until the api `/health` reports ready within
a bounded timeout and SHALL print the `Authorization: Bearer` token to use, along with the api
and (when the web profile is enabled) web URLs and the teardown command. The printed teardown
command SHALL be correct for the profiles that were brought up: when the web console was started
(the `web` profile), the teardown hint SHALL include the `web` profile so it actually removes the
profile-gated `cap-web` (a bare `docker compose down` leaves it running). If `/health` does not
become ready within the bound, the script SHALL fail loudly and point at the api logs.

#### Scenario: Healthy bring-up surfaces the token

- **WHEN** the stack starts and the api becomes healthy
- **THEN** the script prints the bearer token and the api URL, and a subsequent request to a
  token-gated route with that bearer succeeds while an unauthenticated request is rejected

#### Scenario: Teardown hint matches the started profiles

- **WHEN** the bring-up started the web console (web profile enabled)
- **THEN** the printed teardown command includes the `web` profile so running it removes
  `cap-web` as well as the api/postgres, leaving no orphaned profile-gated container

#### Scenario: Unhealthy bring-up fails loudly

- **WHEN** the api does not report `/health` ready within the timeout
- **THEN** the script exits non-zero with a message pointing at the api logs
