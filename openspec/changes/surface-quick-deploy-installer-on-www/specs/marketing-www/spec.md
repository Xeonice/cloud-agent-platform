## MODIFIED Requirements

### Requirement: Landing information architecture

The single landing page SHALL present, in order, a Hero, a Features section, a
How-it-works section, an MCP-connect section, a Security section, and a Self-host
CTA, with navigation and footer. Content SHALL be sourced from real product
capabilities and SHALL NOT claim capabilities the product does not have. The landing
SHALL present BOTH one-line install commands — the source-build `install.sh` and the
prebuilt-image `quick-deploy.sh` — so a visitor can pick the path that fits their host.

#### Scenario: Required sections present

- **WHEN** the landing page is rendered
- **THEN** Hero, Features, How-it-works, MCP-connect, Security, and Self-host CTA
  sections are all present and reachable via in-page navigation

#### Scenario: Hero one-line install command with copy

- **WHEN** a visitor views the Hero
- **THEN** the source-build one-line `curl … /install.sh | sh` command is shown in a
  command block with a working copy-to-clipboard control, alongside the inspectable
  script URL and a disclosed manual `git clone && make up` alternative

#### Scenario: Prebuilt one-line install command is also presented

- **WHEN** a visitor views the install options on the landing
- **THEN** a second one-line `curl … /quick-deploy.sh | bash` command (prebuilt images,
  no OAuth) is shown with copy-to-clipboard and the inspectable script URL, labelled
  with its caveats — amd64-only, legacy-token (not OAuth-first production), host-root
  via `docker.sock`, and prebuilt `cap-web` localhost-only — so it is not mistaken for
  the OAuth-first production path

#### Scenario: Features reflect real capabilities

- **WHEN** a visitor reads the Features section
- **THEN** it describes only real capabilities (per-task container isolation,
  byte-identical terminal streaming, dual runtime Codex + Claude Code, GitHub
  repo import, history/audit/metrics, multi-user OAuth + hard allowlist)

#### Scenario: Security section is honest about the host-root boundary

- **WHEN** a visitor reads the Security section
- **THEN** it discloses that tasks run host-root via `docker.sock` ("who can log
  in = who can run as root on the host") and the fail-closed allowlist posture,
  rather than omitting the caveat

#### Scenario: Both install commands are bilingual

- **WHEN** the landing is rendered in either locale (`en` / `zh`)
- **THEN** both install commands and their caveat copy render in that locale with no
  client-side translation fetch
