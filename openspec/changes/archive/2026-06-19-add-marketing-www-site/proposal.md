## Why

The project is an open-source, self-hostable product, but its only public face
is the marketing landing **inside** the console app (`apps/web/src/routes/index.tsx`):
session-aware, Chinese, operator-facing, and coupled to the backend (it imports
`authSessionQuery` and ships in the console's TanStack Start + Nitro deploy).
That page is an *application front door*, not a *project front door* — it is not
positioned for cold acquisition (GitHub / Hacker News / search), it can break
when the console changes, and it carries hydration/session logic that pure
promotional content does not need.

We want a dedicated public marketing site — the way `vercel.com` is separate
from `vercel.com/dashboard` — that any newcomer hits first: fast, statically
rendered, SEO-indexable, bilingual, with a one-line install command as its
centerpiece. It coexists with the console landing (which degrades to a plain app
entry); it does not replace it.

## What Changes

- Add a new workspace app **`apps/www` (`@cap/www`)**: a **Next.js App Router
  site built with `output: 'export'`** (fully static, zero serverless on
  Vercel), inside the existing pnpm + Turborepo workspace, reusing
  `packages/ui` design tokens.
- Single long-form landing page composed of: **Hero** (headline + one-line
  install command with copy-to-clipboard + live terminal demo), **Features**
  (per-task container isolation, byte-identical terminal streaming, dual runtime
  Codex + Claude Code, GitHub repo import, history/audit/metrics, multi-user
  OAuth + hard allowlist), **How it works** (clone → install → log in → create
  task → watch terminal), an honest **Security** section (host-root via
  `docker.sock` boundary, fail-closed allowlist), and a **Self-host CTA**.
- **Bilingual (zh + en)** with a language toggle; reuse the console landing's
  existing Chinese copy where it fits, author English.
- A hosted **one-line installer**: `public/install.sh` served statically by the
  site, invoked as `curl -fsSL https://<domain>/install.sh | sh`. It wraps the
  real `git clone … && make up` flow, checks for Docker / `docker.sock`, prints
  the Bearer token, warns about slow first-run amd64 emulation on Apple Silicon
  (pointing at `make up-cp`), and the hero exposes the script URL plus an
  auditable manual-clone alternative.
- **Authentic Vercel visual language**: monochrome black/white, Geist Sans +
  Geist Mono, 1px hairline borders, grid/radial backgrounds, restrained fade-up
  motion — honoring the ui-ux-pro-max accessibility/responsive checklist.
- Deploy as a **separate Vercel project on its own domain**; the console keeps
  its own origin. No changes to `apps/web`, `apps/api`, or auth.

## Capabilities

### New Capabilities
- `marketing-www`: a standalone, statically-exported, bilingual Next.js
  promotional site (information architecture, content sourced from real product
  capabilities, Vercel-style design system, SEO/OG metadata, static export, and
  its own deployment) that is fully decoupled from the console and backend.
- `one-line-installer`: a site-hosted `install.sh` consumed via `curl | sh`
  that bootstraps a local self-host by wrapping the existing `make up` flow,
  with environment preflight, honest progress/output, an auditable manual
  alternative, and platform-specific guidance.

### Modified Capabilities
<!-- None. The change is purely additive: a new app + a hosted script. The
     console landing in apps/web is intentionally left unchanged (it degrades to
     an app entry by positioning, not by code change in this proposal). -->

## Impact

- **New code**: `apps/www/**` (Next.js app, components, bilingual content,
  `public/install.sh`); `pnpm-workspace.yaml` / `turbo.json` already glob
  `apps/*` so the app slots in; lockfile updated for Next.js + `geist`.
- **CI**: the new app must pass the existing `ci.yml` gate (install → turbo
  build → typecheck → lint); static export build runs in CI.
- **Deployment**: a new, separate Vercel project + domain (the console deploy is
  untouched); the installer's repo URL/domain is build-time configured.
- **Docs**: README/self-hosting gains a pointer to the public site and the
  `curl | sh` install path; the manual `make up` path remains the source of
  truth the installer wraps.
- **No impact** on `apps/api`, auth, the host-root boundary, or the existing
  console landing's behavior.
