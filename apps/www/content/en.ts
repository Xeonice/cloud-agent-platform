/**
 * English copy for the marketing site.
 *
 * Authored to mirror the bilingual contract in `./index.ts` and the real
 * product capabilities documented in the repo README (per-task container
 * isolation, byte-identical terminal, dual runtime, GitHub import,
 * history/audit/metrics, OAuth + hard allowlist) and the honest host-root
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
      "GitHub OAuth only confirms who you are; the repositories you import decide what the agent can touch; the task queue handles scheduling; and the live terminal leaves the final control with you.",
    methodsHeading: "Get it running",
    copyLabel: "Copy command",
    copiedLabel: "Copied",
    claudeCode: {
      title: "Let Claude Code deploy it",
      badge: "Recommended",
      blurb:
        "Paste this into Claude Code. It reads the installer, checks your host, walks you through GitHub OAuth, and brings the stack up for you.",
      prompt:
        "Deploy cloud-agent-platform on this machine. First read the installer at https://{domain}/install.sh and confirm Docker with a usable docker.sock is available. Then clone https://github.com/{repo}, cd into it, and run `make up` to build and start the full stack. Help me create a GitHub OAuth app and fill the .env for production login against my allowlist, then report the console URL and the Authorization: Bearer token it prints.",
      copyLabel: "Copy the Claude Code prompt",
    },
    install: {
      title: "Install it yourself",
      blurb:
        "Source build with GitHub OAuth — the path for a real, multi-user deployment.",
      command: "curl -fsSL https://{domain}/install.sh | sh",
      inspectLabel: "Inspect the script",
      manual: {
        summary: "Prefer to read it first? Run the same flow by hand:",
        commands: [
          "git clone https://github.com/{repo}.git",
          "cd cloud-agent-platform",
          "make up",
        ],
        note: "make up stays the source of truth — the one-liner only wraps it. It prints an Authorization: Bearer token you log in with.",
      },
    },
    prebuilt: {
      title: "Just try it fast",
      blurb:
        "Prebuilt images, no GitHub OAuth — fastest on amd64 / WSL2, for a local trial.",
      command: "curl -fsSL https://{domain}/quick-deploy.sh | bash",
      inspectLabel: "Inspect the script",
      caveat:
        "Local trial only: it synthesizes a legacy token and the bundled console stays localhost-only — not the production path. amd64 / WSL2.",
      manual: {
        summary: "Prefer to read it first? Run the prebuilt compose by hand:",
        commands: [
          "curl -fsSL https://{domain}/docker-compose.prod.yml -o docker-compose.prod.yml",
          "# write a .env: AUTH_TOKEN_LEGACY_ENABLED=true + AUTH_TOKEN/SESSION_SECRET/CODEX_CRED_ENC_KEY",
          "COMPOSE_PROFILES=web docker compose -f docker-compose.prod.yml up -d",
        ],
        note: "The script does the .env synthesis for you (see the inspectable source). Both files are served by this site — no clone needed. amd64 only.",
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
        title: "OAuth + hard allowlist",
        body: "Multi-user GitHub OAuth gates access against a hard allowlist; there is no public sign-up door.",
      },
    ],
  },
  howItWorks: {
    eyebrow: "How it works",
    title: "From a clean host to a session you can take over.",
    description:
      "Five steps, no bespoke provisioning — the installer wraps the same make up flow you would run by hand.",
    steps: [
      {
        index: "01",
        title: "Clone",
        body: "Pull the public repository onto a host with Docker and a docker.sock available.",
      },
      {
        index: "02",
        title: "Install",
        body: "Run the one-liner (or make up). It builds and starts the stack and prints a local Bearer token.",
      },
      {
        index: "03",
        title: "Log in",
        body: "Sign in with the printed token locally, or with GitHub OAuth against your allowlist in production.",
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
        title: "Fail-closed allowlist",
        body: "Production is OAuth-first and fail-closed: an account that is not on the allowlist stops at access-denied and never reaches any console resource.",
      },
      {
        title: "Write gate before risky actions",
        body: "Commits, pushes, secrets, and PR creation pause for operator confirmation rather than running unattended.",
      },
      {
        title: "Auditable install path",
        body: "The install script is served as plain text you can read before running, and the equivalent manual git clone && make up path is always available.",
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
