# Research Brief — add-marketing-www-site

Lightweight serial research pass (no multi-agent workflow). Grounds the proposal
in the actual repo state as of 2026-06-19.

## Product (what the site must promote, honestly)

From `README.md`: a **self-hostable control plane** that drives the real
interactive Codex CLI (and a second Claude Code runtime per `agent-runtime`),
running each task in a per-task container on the host and streaming a
**byte-identical terminal** to a browser console. Surfaces: task launch, live
workbench/terminal, GitHub repo import, history/audit, metrics, settings,
multi-user GitHub OAuth gated by a hard allowlist, in-app self-update.

Honest differentiator + caveat (must surface, not hide): tasks run **host-root
via `docker.sock`** → "who can log in = who can run as root on the host";
fail-closed allowlist keyed on immutable GitHub numeric id; break-glass legacy
token OFF by default.

Real bring-up (the truth behind any "one command"):
`make up` (full stack, bootstraps `apps/api/.env`, prints a Bearer token) /
`make up-cp` (control-plane only — fast on Apple Silicon, skips the slow amd64
sandbox image build) / `make down` / `make down-v`. Requires Docker + a host
`docker.sock`. Public repo: `github.com/Xeonice/cloud-agent-platform`.

## Existing landing (the key finding)

`apps/web/src/routes/index.tsx` is **already** a polished marketing landing
inside the console app: a top-level route (bypasses the auth gate), with its own
`LandingNav`/`LandingFooter`, a live `RunnerCapsule` terminal demo, a 4-step
`ProcessRail`, a `#security` `BoundaryLedger`, `TrustStrip`, `ProofGrid`. It is
**session-aware** (reads `authSessionQuery`; anonymous → login CTA, authed →
"进入控制台"), Chinese, operator-facing, and **coupled to the console**
(TanStack Start + Nitro deploy, imports backend queries).

## Decisions locked with the user (explore phase)

1. **Coexist** — the new site is the public **front door** (apex / dedicated
   domain, pure static); the console's existing landing degrades to an app
   entry. Analogy: `vercel.com` vs `vercel.com/dashboard`.
2. **Bilingual** (zh + en), language toggle; reuse existing zh copy, write en.
3. **`curl | sh` one-line installer** as the hero command — hosted as a static
   `public/install.sh` by the site itself (not backend work); wraps the real
   `git clone && make up`, with a visible "inspect / manual clone" alternative.

## Stack / placement decisions (defaults, no user objection)

- New workspace app `apps/www` (`@cap/www`), inside the pnpm + Turborepo
  workspace — reuses `packages/ui` tokens, shares turbo/lint/CI.
- **Next.js App Router with `output: 'export'`** → fully static, zero
  serverless on Vercel. (Accepts the cost of a 2nd frontend framework alongside
  the TanStack Start console — justified: different concern = public SEO/SSG.)
- Design: authentic Vercel — monochrome black/white, **Geist Sans + Geist
  Mono**, 1px hairline borders, grid/radial backgrounds, restrained fade-up
  motion. Overrides the ui-ux-pro-max auto-pick of "Vibrant & Block-based" /
  Space Mono (pattern "Minimal Single Column" kept).
- Separate Vercel project + own domain; console stays at its own origin.

## Constraints / risks discovered

- The installer's repo URL/domain must be injected at build or pinned; the
  script must warn that first `make up` on Apple Silicon is slow (amd64
  emulation) and point at `make up-cp`.
- `curl | sh` runs a host-root tool — consistent with the threat model, but the
  site must show the script URL and offer the auditable manual path.
- ui-ux-pro-max pre-delivery checklist (a11y, reduced-motion, contrast,
  responsive 375/768/1024/1440) applies.
- CI gate (`ci.yml`: install → turbo build → typecheck → lint) must pass for the
  new app; a new app needs to slot into the workspace cleanly.
