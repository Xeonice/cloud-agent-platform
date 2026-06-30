/**
 * English copy for the marketing site.
 *
 * Authored to mirror the bilingual contract in `./index.ts` and the real
 * product capabilities documented in the repo README (per-task container
 * isolation, byte-identical terminal, dual runtime, GitHub import,
 * history/audit/metrics, local accounts + PATs) and the honest host-root
 * boundary. The Chinese counterpart in `./zh.ts` ports the console landing's
 * existing zh copy; this file is the authored English equivalent.
 *
 * `installCommand` carries a `{domain}` token that the installer build step
 * (5.3) fills with the published site domain — this module ships no live URL.
 */
import type { SiteContent } from "./index";

export const en: SiteContent = {
  meta: {
    title: "cloud-agent-platform — self-hostable remote agent control plane",
    description:
      "A self-hostable control plane that runs Codex and Claude Code in isolated containers and streams a byte-identical terminal to your browser. One command to bring it up locally.",
  },
  languageToggleLabel: "Switch language",
  nav: {
    links: [
      { label: "Features", href: "#features" },
      { label: "How it works", href: "#how-it-works" },
      { label: "MCP", href: "#mcp" },
      { label: "Security", href: "#security" },
    ],
    console: { label: "Console", href: "#self-host" },
    cta: { label: "Self-host", href: "#self-host" },
  },
  hero: {
    eyebrow: "Self-hosted remote agent control",
    title: "A remote agent run pool, built for the operator.",
    subtitle: "Turn every CLI session into a workflow you can take over.",
    description:
      "Local accounts control who can enter; per-account forge PATs decide what repositories the agent can touch; the task queue handles scheduling; and the live terminal leaves the final control with you.",
    methodsHeading: "Get it running",
    copyLabel: "Copy command",
    copiedLabel: "Copied",
    claudeCode: {
      title: "Let Claude Code deploy it",
      badge: "Recommended",
      blurb:
        "Paste this into Claude Code. It reads the release-image installer, checks or installs Docker only when absent, and brings up the prebuilt stack.",
      prompt:
        "Deploy cloud-agent-platform on this machine. First read https://{domain}/install.sh and https://{domain}/quick-deploy.sh, run the release-image install path, and ensure Docker is usable: install Docker/Compose only if absent, leave existing usable Docker untouched, and stop with remediation if docker.sock/daemon/context is unreachable. Do not git clone, do not run make up, and do not build locally. It defaults to the latest Release; set CAP_VERSION to pin one. On macOS use CAP_SANDBOX_PROVIDER=boxlite and confirm BOXLITE_ENDPOINT and BOXLITE_API_TOKEN are set; leave BOXLITE_IMAGE unset to use the matching Release-asset rootfs, or set BOXLITE_IMAGE to force registry image mode. On Linux use the default AIO path. Report the console URL, the /version response, and the admin email/password it prints.",
      copyLabel: "Copy the Claude Code prompt",
    },
    install: {
      title: "Install it yourself",
      blurb:
        "Prebuilt release images — no clone, no local build. Installs Docker only when absent; macOS uses BoxLite, Linux uses AIO.",
      command: "curl -fsSL https://{domain}/install.sh | sh",
      inspectLabel: "Inspect the script",
      manual: {
        summary: "Prefer to read it first? Run the same release-artifact flow by hand:",
        commands: [
          "curl -fsSL https://{domain}/docker-compose.prod.yml -o docker-compose.prod.yml",
          "# write .env: CAP_VERSION=vX.Y.Z + ADMIN_EMAIL/ADMIN_PASSWORD + PASSWORD_AUTH_ENABLED=true + SESSION_SECRET/CODEX_CRED_ENC_KEY",
          "# macOS/BoxLite also needs: CAP_SANDBOX_PROVIDER=boxlite + BOXLITE_ENDPOINT/BOXLITE_API_TOKEN",
          "# same-host BoxLite: BOXLITE_ENDPOINT=http://host.docker.internal:7331 + BOXLITE_READINESS_ENDPOINT=http://127.0.0.1:7331",
          "# Optional BoxLite defaults: BOXLITE_PROTOCOL_MODE=native + BOXLITE_PATH_PREFIX=default",
          "# Linux/AIO also include: aio-sandbox-image",
          "COMPOSE_PROFILES=web docker compose -f docker-compose.prod.yml up -d api postgres web",
        ],
        note: "install.sh delegates to quick-deploy.sh; the source of truth is docker-compose.prod.yml plus GHCR release images and matching sandbox Release assets. api/web bind 0.0.0.0 by default; public DNS/TLS/proxy remain yours.",
      },
    },
    prebuilt: {
      title: "Run quick-deploy directly",
      blurb:
        "The same release-image path, exposed directly for agents or manual step-by-step debugging.",
      command: "curl -fsSL https://{domain}/quick-deploy.sh | bash",
      inspectLabel: "Inspect the script",
      caveat:
        "It creates or reuses a local admin account, validates the selected sandbox provider, and keeps the bundled console local-trial oriented. Public DNS, TLS, proxy, and auth origins remain yours.",
      manual: {
        summary: "Prefer to read it first? Run the prebuilt compose by hand:",
        commands: [
          "curl -fsSL https://{domain}/docker-compose.prod.yml -o docker-compose.prod.yml",
          "# write .env: CAP_VERSION=vX.Y.Z + ADMIN_EMAIL/ADMIN_PASSWORD + PASSWORD_AUTH_ENABLED=true + SESSION_SECRET/CODEX_CRED_ENC_KEY",
          "# macOS/BoxLite also needs: CAP_SANDBOX_PROVIDER=boxlite + BOXLITE_*",
          "# Optional smoke: RUN_GITHUB_VALIDATION=1 with GITHUB_VALIDATION_TOKEN or ignored .env.github-validation",
          "# Linux/AIO also include: aio-sandbox-image",
          "COMPOSE_PROFILES=web docker compose -f docker-compose.prod.yml up -d api postgres web",
        ],
        note: "The script does the .env synthesis for you (see the inspectable source). Both files are served by this site — no clone and no local build needed.",
      },
    },
    secondaryCta: { label: "See how it works", href: "#how-it-works" },
  },
  terminal: {
    caption: "task → runner lease → operator takeover",
    lines: [
      { kind: "comment", text: "# task assigned to an idle runner" },
      { kind: "prompt", text: "codex \"refactor the auth guard\"" },
      { kind: "output", text: "● reading apps/api/src/auth/guard.ts" },
      { kind: "output", text: "● proposing edit — 24 insertions, 11 deletions" },
      { kind: "comment", text: "# write gate: paused for operator takeover" },
      { kind: "prompt", text: "git commit -m \"harden auth guard\"" },
      { kind: "output", text: "✓ approved by operator — committed" },
    ],
  },
  features: {
    eyebrow: "Capabilities",
    title: "Everything is scoped to a task, not handed to the agent.",
    description:
      "Built from what the platform actually does today — no roadmap claims, just the real surface.",
    items: [
      {
        title: "Per-task container isolation",
        body: "Each task runs in its own container on the host, so one session's blast radius never reaches another.",
      },
      {
        title: "Byte-identical terminal",
        body: "The real interactive CLI is streamed to the browser byte-for-byte — what you see is exactly what ran.",
      },
      {
        title: "Dual runtime",
        body: "Run tasks on Codex or Claude Code; pick the runtime per task without leaving the console.",
      },
      {
        title: "GitHub repository import",
        body: "Import repos from your GitHub account to define the agent's reachable scope — it does not scan everything you own.",
      },
      {
        title: "History, audit & metrics",
        body: "Tasks, commands, agent output, and GitHub events are recorded; metrics surface how the run pool is being used.",
      },
      {
        title: "Local accounts + PATs",
        body: "Console login uses local accounts; repository access is scoped separately through each operator's forge PATs.",
      },
    ],
  },
  howItWorks: {
    eyebrow: "How it works",
    title: "From a clean host to a session you can take over.",
    description:
      "Five steps, no local source build — the installer runs the published release-image package you can inspect by hand.",
    steps: [
      {
        index: "01",
        title: "Prepare",
        body: "Choose a host with Docker and a docker.sock available; on macOS, point CAP at your BoxLite control plane.",
      },
      {
        index: "02",
        title: "Install",
        body: "Run the one-liner. It pulls the published release images, starts api/postgres/web, and prints the admin email/password.",
      },
      {
        index: "03",
        title: "Log in",
        body: "Use the printed admin email/password, then change that initial password; repository access stays scoped through each account's forge PATs.",
      },
      {
        index: "04",
        title: "Create a task",
        body: "Import a repository, pick a runtime, and queue a task; the control plane leases an idle runner.",
      },
      {
        index: "05",
        title: "Watch the terminal",
        body: "Follow the live, byte-identical terminal and take over before commits, pushes, secrets, or PRs.",
      },
    ],
  },
  mcpConnect: {
    eyebrow: "Remote MCP",
    title: "Connect your MCP client to the run pool.",
    description:
      "Drive platform tasks straight from an MCP client. Point it at the remote MCP server over Streamable HTTP and authenticate with a token you mint in the console.",
    endpointLabel: "Streamable HTTP endpoint",
    endpoint: "https://{apiDomain}/mcp",
    copyLabel: "Copy MCP endpoint",
    copiedLabel: "Copied",
    installLabel: "Install commands",
    directLabel: "A · Direct (recommended)",
    directCommand:
      'claude mcp add --transport http cap https://{apiDomain}/mcp --header "Authorization: Bearer mcp_<token>"',
    fallbackLabel: "B · mcp-remote (stdio-only clients)",
    fallbackCommand:
      'npx mcp-remote https://{apiDomain}/mcp --header "Authorization: Bearer mcp_<token>"',
    transportNote:
      "Most clients (Claude Code, Cursor, VS Code) speak Streamable HTTP — use A. Stdio-only clients run a local process; npx mcp-remote (B) bridges that local stdio to this remote endpoint. Either way, mint the token in the console first.",
    steps: [
      {
        index: "01",
        title: "Add the server",
        body: "In Cursor, Claude Desktop, or VS Code, add an MCP server and set its URL to the Streamable HTTP endpoint above.",
      },
      {
        index: "02",
        title: "Paste your token",
        body: "Send the minted mcp_ token as an Authorization: Bearer <token> header on the connection.",
      },
      {
        index: "03",
        title: "Drive tasks",
        body: "Your client lists the platform's tools and can read repos and create or stop tasks within the token's scopes.",
      },
    ],
    tokenNote:
      "Tokens are minted in the console settings page — the MCP Server section issues an mcp_ token once, scoped to what you allow. This page documents the connection; it never mints a token.",
    tokenCta: { label: "Mint a token in your console", href: "#self-host" },
  },
  security: {
    eyebrow: "Security",
    title: "Honest about the boundary: console access is host-root.",
    description:
      "We do not hide the trust model. Read this before you deploy beyond your own machine.",
    points: [
      {
        title: "Tasks run host-root via docker.sock",
        body: "The backend drives tasks through the Docker socket, so whoever can log in can effectively run as root on the host. Treat console access as a host-root privilege.",
      },
      {
        title: "Fail-closed access",
        body: "Production auth is fail-closed: disabled accounts and invalid sessions stop before they reach any console resource.",
      },
      {
        title: "Write gate before risky actions",
        body: "Commits, pushes, secrets, and PR creation pause for operator confirmation rather than running unattended.",
      },
      {
        title: "Auditable install path",
        body: "The install script is served as plain text you can read before running, and the equivalent manual release-compose path is always available.",
      },
    ],
  },
  selfHost: {
    eyebrow: "Self-host",
    title: "It runs entirely on your own infrastructure.",
    description:
      "Open source, no telemetry, no installer-as-a-service. One command brings up the full stack on a host you control.",
    primaryCta: { label: "Copy install command", href: "#install" },
    secondaryCta: { label: "Read the manual setup", href: "#how-it-works" },
  },
  footer: {
    tagline: "A self-hostable control plane for remote agent runs.",
    links: [
      { label: "Features", href: "#features" },
      { label: "How it works", href: "#how-it-works" },
      { label: "MCP", href: "#mcp" },
      { label: "Security", href: "#security" },
      { label: "GitHub", href: "https://github.com/{repo}" },
    ],
    legal: "Open source. Self-hosted. Host-root by design — deploy accordingly.",
  },
};
