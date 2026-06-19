# Verification Report — add-marketing-www-site

Adversarial spec verification with three-way routing. Each requirement was
re-traced end-to-end against the actual `apps/www` implementation and the
emitted static export (`apps/www/out/`). The skeptic flagged **zero**
requirements as raw-unmet; every requirement below was independently re-traced
and confirmed MET (no rubber-stamping). No requirement re-opened as a code task,
no new spec defect routed to design.md Open Questions.

## Tally

- **verify-reopened code tasks:** 0
- **spec defects (design.md Open Questions):** 0
- **MET (folded below):** 9 requirements

---

## MET requirements (re-traced end-to-end)

### [marketing-www] Standalone statically-exported site — MET

- `apps/www/next.config.ts:26` sets `output: "export"`; `images.unoptimized`
  and `outputFileTracingRoot` (monorepo root) are configured for export.
- `apps/www/out/` exists with static HTML/CSS/JS (`en/`, `zh/`, `index.html`,
  `404.html`, `_next/`, `install.sh`, `opengraph-image.png`) — no serverless /
  API function output.
- `apps/www` is registered in `pnpm-workspace.yaml:4`; CI gate
  (`.github/workflows/ci.yml:51,54`) runs `pnpm turbo build` then
  `pnpm turbo typecheck lint`, which covers `@cap/www`. `package.json` exposes
  `build` (`next build && node scripts/inject-install-sh.mjs`), `typecheck`
  (`tsc --noEmit`), and `lint` (`eslint .`). The captured
  `apps/www/.turbo/turbo-build.log` shows a successful build + injection.

### [marketing-www] Decoupled from console and backend — MET

- A repo-wide grep over `apps/www/{app,components,lib,content}` for `@cap/api`,
  `authSessionQuery`, and `useSession` returns **no matches** — no backend
  import, no session/auth query, no runtime backend fetch. The static export
  renders fully offline.

### [marketing-www] Landing information architecture — MET

- The exported `out/en/index.html` contains all required section anchors:
  `id="features"`, `id="how-it-works"`, `id="security"`, `id="self-host"`,
  plus a hero/`id="install"` and `id="main"`. Sections are reachable via in-page
  nav (`SiteNav` renders `nav.links` anchors).
- Hero one-line install with copy: `out/en/index.html` shows
  `curl -fsSL https://<domain>/install.sh | sh` in a command block; `CommandBox`
  provides copy-to-clipboard; the inspectable script URL and a disclosed manual
  `git clone … && make up` alternative are both present in the rendered HTML.
- Features copy enumerates the real capabilities (container isolation, terminal,
  dual runtime Codex + Claude Code, GitHub import, history/audit/metrics, OAuth +
  hard allowlist); Security section discloses the host-root `docker.sock`
  boundary and fail-closed allowlist (sourced from `content/{en,zh}.ts`).

### [marketing-www] Bilingual content — MET

- Both locales export statically: `out/en/index.html` (`<html lang="en">`) and
  `out/zh/index.html` (`<html lang="zh-Hans">`). `LOCALES = ["en","zh"]` drives
  `generateStaticParams`; content is resolved at build (`content/index.ts`,
  `getContent`), no client-side translation fetch.
- `LanguageToggle` swaps the locale URL segment (`components/language-toggle.tsx`,
  used in `SiteNav`).
- SEO alternates: exported HTML carries
  `rel="alternate" hrefLang="en" | "zh-Hans" | "x-default"` (Next renders the
  attribute camelCased as `hrefLang`). The spec asks a locale page to link to the
  other locale; the implementation emits a superset (self + other + x-default).

### [marketing-www] Vercel-style design system and accessibility — MET

- Geist Sans + Geist Mono and the monochrome token set are wired in
  `app/[locale]/layout.tsx` + `app/globals.css`; hairline borders / grid+radial
  backgrounds are present.
- `prefers-reduced-motion` is honored: `FadeUp` defaults to the resting,
  fully-visible state (`usePrefersReducedMotion` initializes `reduced = true`,
  no motion classes emitted when reduced), and motion classes are
  `motion-safe:`-gated. Focus-visible rings and `cursor-pointer` are present on
  interactive controls; the icon-light language toggle carries an accessible
  group label. Responsive breakpoint classes (`md:`, `sm:`, `hidden`) are used
  throughout.

### [marketing-www] SEO and social metadata — MET

- Exported `out/en/index.html` contains `<title>`, `name="description"`,
  `rel="canonical"`, `property="og:title"`, `property="og:image"`, and
  `name="twitter:card"`. An `opengraph-image.png` ships in `out/`. URLs are
  resolved from `NEXT_PUBLIC_SITE_URL` via `lib/site-config` + `lib/hreflang`.

### [one-line-installer] Site-hosted install script — MET

- `public/install.sh` is copied verbatim into the static export (`out/install.sh`
  exists, mode `0755`); `vercel.json` serves it with
  `Content-Type: text/plain; charset=utf-8` and no server-side execution.
- Build-time resolution: `scripts/inject-install-sh.mjs` rewrites the
  `REPO_URL=`/`SITE_DOMAIN=` assignment lines and strips the fallback `case`
  arms when `NEXT_PUBLIC_REPO_URL` / `NEXT_PUBLIC_SITE_URL` are set. A simulated
  configured build confirms **zero** `__CAP_*__` markers remain and literal
  values are substituted. (The local `out/install.sh` retains markers only
  because the dev build ran with those env vars unset — the script then warns and
  keeps its in-file public fallbacks, which is the documented behavior, not a
  defect.)

### [one-line-installer] Installer wraps the real bring-up flow — MET

- `install.sh` preflights, `git clone --depth 1 "$REPO_URL"`, `cd`, then
  `make "$UP_TARGET"` (`up` / `up-cp`). No bespoke provisioning: it delegates
  bring-up to `make` and surfaces the printed `Authorization: Bearer` token by
  not capturing stdout (`install.sh:86-98`).

### [one-line-installer] Environment preflight and honest failure — MET

- Preflight runs before any mutation: `command -v docker` and `docker info`
  (daemon/`docker.sock` reachability) with clear `die` messages
  (`install.sh:52-61`); arm64 hosts get a warning that the first `make up` is
  slow under amd64 emulation and a default to the faster `make up-cp`
  (`install.sh:69-78`).

### [one-line-installer] Auditable and disclosed — MET

- The Hero exposes the inspectable script URL and a disclosed manual
  `git clone … && make up` alternative (confirmed in `out/en/index.html` and
  `content/{en,zh}.ts` `hero.manual`).

---

## Gap analysis

All requirements have a traceable, end-to-end-verified implementation; nothing
is completely absent. No coverage gap found.

---

## Scope findings (extra behavior beyond spec — informational, not violations)

The following behaviors exist in the implementation without an explicit backing
requirement. None contradicts a requirement; all are reasonable
production/SEO/UX hardening. Recorded for transparency, not routed as tasks.

1. `apps/www/public/install.sh:50` — `command -v git` prerequisite check (spec
   names only the Docker/`docker.sock` preflight scenario). Reasonable: the
   script clones via `git`.
2. `apps/www/public/install.sh:83-85` — exits when the clone destination already
   exists (no such scenario in spec). Reasonable: avoids clobbering.
3. `apps/www/public/install.sh:31` — `CAP_CLONE_DIR` env override of the clone
   dir (spec only requires clone + `cd`).
4. `apps/www/public/install.sh:80` — `CAP_UP_TARGET` env override of the make
   target (spec says `make up` / `make up-cp` on arm64).
5. `apps/www/public/install.sh:34-42` — ANSI color `info`/`warn`/`die` helpers
   (spec requires only a "clear message"). TTY-gated.
6. `apps/www/scripts/inject-install-sh.mjs:34-49,74-76` — writes a host-agnostic
   `out/index.html` meta-refresh/JS redirect page for the bare `/` URL (spec has
   no root-URL redirect requirement). Necessary because the locale-segmented
   layout emits no top-level `index.html`.
7. `apps/www/vercel.json:13-27` — `Cache-Control: public, max-age=300,
   must-revalidate` on `/install.sh` (spec only requires plain-text static
   serving).
8. `apps/www/vercel.json:6-11` — 307 redirect from `/` to `/en/` (spec does not
   specify root-URL redirect behavior). Pairs with finding 6 as the Vercel-side
   redirect.
9. `apps/www/content/index.ts:55-63` — `NavContent.console` field exists in the
   content contract and is populated in `en`/`zh`, but `SiteNav`
   (`components/site-nav.tsx`) renders only `nav.links` and `nav.cta` — the
   `console` field is currently dead schema data. Benign (no broken behavior,
   no false claim); a candidate for cleanup or future use, not a requirement
   violation.
10. `apps/www/components/motion/fade-up.tsx:64-86` — `IntersectionObserver`
    reveal-on-scroll (spec requires only suppression under
    `prefers-reduced-motion`; scroll-gating is an additive motion choice, fully
    suppressed under reduced motion). Matches design.md D5 "fade-up-on-scroll".
11. `apps/www/lib/hreflang.ts:74-77` — emits an `x-default` alternate in addition
    to per-locale alternates (spec requires links to the other locale;
    `x-default` is the search-engine-recommended superset).
12. `apps/www/vercel.json:4` — `buildCommand` override
    (`next build && node scripts/inject-install-sh.mjs`) is the mechanism that
    realizes the build-time install.sh injection requirement; not separately
    spec'd but required to satisfy it.

## Verdict

All 9 requirements MET. Change is verified; gate may proceed.
