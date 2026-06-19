## Context

The repo is a pnpm + Turborepo workspace (`apps/*`, `packages/*`). The only
public-facing page today is `apps/web/src/routes/index.tsx` — a session-aware,
backend-coupled marketing landing that ships inside the TanStack Start console
(deployed to Vercel via the Nitro `vercel` preset). The README documents the
true local bring-up (`make up` / `make up-cp`, Docker + `docker.sock` required,
prints a Bearer token) and the host-root security boundary.

We are adding a **separate public marketing site** that any newcomer hits first.
Three decisions were locked with the user during explore: (1) it **coexists**
with the console landing as the public front door (the console landing degrades
to an app entry, no code change to it here); (2) it is **bilingual** (zh + en);
(3) its hero command is a **`curl | sh` one-line installer** hosted by the site
itself. The notable tension this design must own: the repo *just migrated off
Next.js to TanStack Start*, and we are reintroducing Next.js for this one app.

## Goals / Non-Goals

**Goals:**
- A fully static (`output: 'export'`), SEO-indexable, fast public site, fully
  decoupled from the console and backend (zero `@cap/api`/session imports).
- Honest content sourced from real capabilities, including the host-root caveat.
- Bilingual zh/en with zero runtime cost (locale resolved at build → static
  HTML per locale).
- A hosted `install.sh` that wraps — never reimplements — the real `make up`
  flow, with preflight + auditable manual alternative.
- Authentic Vercel visual language; pass the ui-ux-pro-max a11y/responsive bar.

**Non-Goals:**
- Replacing or modifying the console landing (`apps/web`), `apps/api`, or auth.
- A real backend/installer-as-a-service, telemetry, or release-download logic
  beyond wrapping `git clone && make up`.
- A blog/MDX/docs portal (leave room for it; do not build it now).
- Changing the host-root security model or the `make up` source-of-truth flow.

## Decisions

### D1 — New app `apps/www` (`@cap/www`) inside the monorepo, not a separate repo
Reuses `packages/ui` tokens, shared turbo/lint/CI, single source tree for OSS
visitors. Alternative (standalone repo) rejected: duplicates tooling and drifts
from the product it advertises. `pnpm-workspace.yaml`/`turbo.json` already glob
`apps/*`, so it slots in.

### D2 — Next.js App Router with `output: 'export'`
The user asked for Next.js static. `output: 'export'` yields pure static HTML
with no serverless functions on Vercel. Trade-off accepted: a 2nd frontend
framework coexists with the TanStack Start console. Rationale: a marketing site
is a *different concern* (SEO/SSG/OG/future MDX) than an authenticated app, and
static export is the lowest-operational-cost target. Alternatives considered:
reuse TanStack Start (rejected — user asked Next.js, and SSG export is more
idiomatic in Next for a content site); plain HTML/Tailwind (rejected — loses
i18n routing, component ergonomics, and OG image tooling).

### D3 — Bilingual via locale-segmented static export
Use App Router `app/[locale]/...` with a small typed content module
(`content/{en,zh}.ts`) and a language toggle. Each locale exports its own static
HTML; no runtime i18n library is strictly required, but `next-intl` (static/SSG
mode) is acceptable if it simplifies. Reuse the console landing's zh copy where
it fits; author en. `generateStaticParams` enumerates locales. Default locale +
`<link rel="alternate" hreflang>` for SEO.

### D4 — Installer is a static `public/install.sh` served by the site
`curl -fsSL https://<domain>/install.sh | sh`. The script is a thin wrapper:
preflight (`docker` + `docker.sock`), `git clone` the public repo, `cd`, run
`make up` (or `make up-cp` when it detects arm64), then surface the printed
Bearer token. It hard-codes/templating-injects the repo URL and site domain at
build time. Because it is just a file in `public/`, it needs **no backend** and
ships with the same static deploy. The hero shows the command, a copy button,
the inspectable script URL, and a disclosed manual `git clone && make up`
alternative (curl|sh runs a host-root tool — disclosure is the professional and
threat-model-consistent choice).

### D5 — Authentic Vercel design system (override the skill auto-pick)
Monochrome black/white, **Geist Sans + Geist Mono** (`geist` package),
1px hairline borders (`#ffffff14`-class), grid/radial-gradient backgrounds,
restrained fade-up-on-scroll motion (`prefers-reduced-motion` respected). Keeps
the ui-ux-pro-max "Minimal Single Column" pattern; rejects its "Vibrant &
Block-based" / Space Mono auto-pick as off-brand for Vercel. The hero terminal
demo reuses the *concept* of the console's `RunnerCapsule` but is re-implemented
statically (no backend stream).

### D6 — Separate Vercel project + own domain
The console deploy is untouched. The new project builds the static export and
serves it (including `install.sh`) from a dedicated domain. Build-time env
provides the public site domain + repo URL consumed by both metadata and the
installer template.

## Risks / Trade-offs

- **Two frontend frameworks in one repo** → Mitigation: isolate to `apps/www`,
  no shared runtime with `apps/web`; only `packages/ui` tokens are shared (and
  only if Next-compatible — otherwise mirror tokens as CSS vars).
- **`curl | sh` for a host-root tool** → Mitigation: show the script URL, offer
  the auditable manual path, keep the script short/readable; document that
  console access already equals host-root, so the trust step is explicit.
- **Installer drifts from real `make up` flow** → Mitigation: the script wraps
  `make up`/`make up-cp` and clones the repo rather than reimplementing bring-up;
  it has no bespoke provisioning logic to drift.
- **Slow first `make up` on Apple Silicon (amd64 emulation)** → Mitigation: the
  script detects arm64 and prints guidance / prefers `make up-cp`.
- **Content goes stale vs. product** → Mitigation: copy is sourced from README
  capabilities; keep claims capability-level, not version-specific.
- **CI/static-export breakage** → Mitigation: the app must pass `ci.yml`
  (install → turbo build → typecheck → lint); export build runs in CI.
- **`packages/ui` may assume the console's Tailwind/runtime** → Mitigation: if
  importing components is friction, consume only design tokens / restyle with
  Tailwind in `apps/www`; do not force-fit console components.

## Migration Plan

Purely additive — no migration of existing surfaces. Rollout: (1) scaffold
`apps/www` and verify `turbo build`/typecheck/lint locally; (2) implement the
page, content, installer, and design; (3) create the separate Vercel project +
domain and deploy the static export; (4) add README/self-hosting pointers to the
public site and the `curl | sh` path. Rollback: remove the Vercel project /
unpublish the domain; deleting `apps/www` leaves `apps/web` and the backend
untouched.

## Open Questions

- Final production domain for the site, and whether `install.sh` is served from
  the apex or a `get.`-style subdomain.
- Whether to adopt `next-intl` or hand-roll the locale content module.
- Whether to import `packages/ui` components or mirror only tokens into
  `apps/www` (depends on `packages/ui`'s Next compatibility).
- Whether the installer should offer a control-plane-only (`make up-cp`) flag/
  prompt as a first-class choice rather than just a printed hint.
