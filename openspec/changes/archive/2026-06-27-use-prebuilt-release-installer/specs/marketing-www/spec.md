## MODIFIED Requirements

### Requirement: Landing information architecture

The single landing page SHALL present, in order, a Hero, a Features section, a How-it-works section,
an MCP-connect section, a Security section, and a Self-host CTA, with navigation and footer. Content
SHALL be sourced from real product capabilities and SHALL NOT claim capabilities the product does
not have. The landing SHALL present the release-image `install.sh` wrapper and the direct
prebuilt-image `quick-deploy.sh` command so a visitor can run the same published-artifact path
either way.

#### Scenario: Required sections present

- **WHEN** the landing page is rendered
- **THEN** Hero, Features, How-it-works, MCP-connect, Security, and Self-host CTA sections are all
  present and reachable via in-page navigation

#### Scenario: Hero release-image install command with copy

- **WHEN** a visitor views the Hero
- **THEN** the release-image one-line `curl ... /install.sh | sh` command is shown in a command
  block with a working copy-to-clipboard control, alongside the inspectable script URL and a
  disclosed manual `docker-compose.prod.yml` + `.env` alternative

#### Scenario: Direct quick-deploy command is also presented

- **WHEN** a visitor views the install options on the landing
- **THEN** a second one-line `curl ... /quick-deploy.sh | bash` command (prebuilt images, no OAuth)
  is shown with copy-to-clipboard and the inspectable script URL, labelled with its caveats --
  platform-aware macOS BoxLite / Linux AIO, explicit AIO requires amd64, legacy-token (not
  local-account production), host-root via `docker.sock`, and prebuilt `cap-web` localhost-only --
  so it is not mistaken for the local-account production path

#### Scenario: Features reflect real capabilities

- **WHEN** a visitor reads the Features section
- **THEN** it describes only real capabilities (per-task container isolation, byte-identical
  terminal streaming, dual runtime Codex + Claude Code, GitHub repo import, history/audit/metrics,
  local accounts + per-account forge PATs)
