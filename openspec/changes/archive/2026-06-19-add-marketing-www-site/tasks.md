<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within
     a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: scaffolding (depends: none)

- [x] 1.1 Create `apps/www` as `@cap/www` (package.json with Next.js + React + `geist`, dev/build/typecheck/lint scripts) so it slots into the pnpm + Turborepo `apps/*` glob
- [x] 1.2 Add `next.config.ts` with `output: 'export'` (+ `images.unoptimized` as required for static export) and a `tsconfig.json` extending `@cap/tsconfig`
- [x] 1.3 Add Tailwind config + base globals and an empty `app/` shell that builds to a static `out/` directory; confirm `pnpm --filter @cap/www build` emits only static assets
- [x] 1.4 Wire build-time public config (site domain + public repo URL) via env, consumed later by metadata and the installer template

<!--
  PARTITION CORRECTED after a codebase scan (apps/www is greenfield; almost all
  files are net-new under apps/www/). Shared-file findings that drove the
  rebalance:
    - apps/www/app/layout.tsx (+ its app/[locale]/layout.tsx successor): written
      by design-system 2.1 (Geist fonts/tokens) AND 2.4 (metadata export) AND
      restructured by i18n 3.1 (locale routing). Cross-track → integration.
    - apps/www/next.config.ts: created by scaffolding 1.2/1.4 AND edited by
      installer 5.3 (build-time install.sh injection, which also depends on the
      1.4 env wiring). Cross-track → integration.
    - apps/www/app/[locale]/page.tsx: the single landing root assembled by 4.5,
      wrapped by 3.1's layout; the whole landing-page track (4.x) is the
      convergence of design-system + i18n + their shared layout/page → serial
      tail → integration.
    - Root pnpm-workspace.yaml (explicit list, NOT a glob — design.md was wrong)
      + pnpm-lock.yaml: only scaffolding 1.1 touches them. Not cross-track.
  Parallel tracks below are file-disjoint (each owns its own apps/www subtree);
  the integrationTrack runs serially after them over the shared layout/page/
  next.config plus deploy + docs.
-->

## 2. Track: design-system (depends: scaffolding)

- [x] 2.2 Build shared primitives (`Section`, `Container`, `CommandBox` with copy-to-clipboard, hairline `Card`, `Button`) honoring focus states and `cursor-pointer`
- [x] 2.3 Add fade-up-on-scroll motion utilities gated behind `prefers-reduced-motion`

## 3. Track: i18n-content (depends: scaffolding)

- [x] 3.2 Add typed bilingual content module `content/{en,zh}.ts` covering all section copy; port the console landing's zh copy where it fits, author en
- [x] 3.3 Build a language toggle that switches locale via URL and emit `hreflang` alternate links

## 4. Track: installer (depends: scaffolding)

- [x] 5.1 Author `public/install.sh`: preflight (Docker + `docker.sock`), clone the public repo, `cd`, run `make up`, surface the printed Bearer token
- [x] 5.2 Add arm64 detection that warns about slow first `make up` under amd64 emulation and points at `make up-cp`

## 5. Track: integration (depends: design-system, i18n-content, installer)

<!-- Serial. Shared layout/page/next.config edits + the full landing-page
     assembly + build-time installer injection + deploy/CI/docs. -->

- [x] 2.1 Wire Geist Sans + Geist Mono and the monochrome black/white token set (hairline border color, grid/radial background utilities) in `app/layout.tsx` + globals
- [x] 2.4 Add SEO/OG metadata helpers and an Open Graph image (title, description, canonical, OG/Twitter tags)
- [x] 3.1 Add locale-segmented routing (`app/[locale]/...`) with `generateStaticParams` enumerating `en` + `zh` and a default locale
- [x] 4.1 Build the Hero: headline, `CommandBox` showing the `curl | sh` one-liner with copy, the inspectable script URL, and a disclosed manual `git clone && make up` alternative
- [x] 4.2 Build a static terminal demo (re-implementing the `RunnerCapsule` concept, no backend stream, reduced-motion-safe)
- [x] 4.3 Build the Features section (per-task container isolation, byte-identical terminal, dual runtime Codex + Claude Code, GitHub import, history/audit/metrics, OAuth + hard allowlist)
- [x] 4.4 Build the How-it-works section (clone → install → log in → create task → watch terminal) and the honest Security section (host-root via `docker.sock`, fail-closed allowlist)
- [x] 4.5 Build the Self-host CTA, nav, and footer; assemble the single page from the bilingual content module
- [x] 5.3 Inject the repo URL + site domain into `install.sh` at build time (no placeholders in the published file) and confirm it is served as plain text from the static output
- [x] 4.6 Verify a11y (4.5:1 contrast, focus, icon labels) and responsiveness at 375/768/1024/1440 with no horizontal scroll
- [x] 6.1 Add the separate Vercel project configuration for the static export (own domain; console deploy untouched)
- [x] 6.2 Ensure `@cap/www` passes the repo CI gate (install → turbo build → typecheck → lint)
- [x] 6.3 Add README + `docs/self-hosting.md` pointers to the public site and the `curl | sh` install path (manual `make up` stays the source of truth)
