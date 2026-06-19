import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Static-export config (design D2 / marketing-www spec "Standalone
 * statically-exported site"). For `next build`, `output: 'export'` emits a pure
 * static `out/` directory (HTML/CSS/JS) with NO serverless/API functions, so the
 * site deploys to its own Vercel project with zero backend coupling.
 *
 * `images.unoptimized` is required under `output: 'export'`: the default
 * next/image Image Optimization API needs a server, which static export does not
 * provide, so optimization is disabled and images are served as-is.
 *
 * `trailingSlash` makes each route export as a directory `index.html`
 * (e.g. /en/ -> /en/index.html), which static hosts (and the Vercel static
 * deploy) serve cleanly without rewrites.
 *
 * `outputFileTracingRoot` pins the monorepo root (two levels up from apps/www)
 * so Next.js does not "infer" a wrong workspace root when multiple lockfiles are
 * present on the machine (this app lives in a pnpm + Turborepo workspace).
 *
 * Dev vs build (important): `output: 'export'` is a BUILD concern. Pairing it
 * with `next dev` makes the dev server's on-demand chunk compilation flaky
 * (intermittent `MODULE_NOT_FOUND ./NNN.js` 500s), so it is applied only for the
 * production build. In dev we instead add a `/` → default-locale redirect: the
 * app is locale-segmented with its root layout at `app/[locale]/layout.tsx`, so
 * there is no `/` route and the bare root would otherwise 404 under `next dev`.
 * In production that root redirect is written post-build into `out/index.html`
 * by `scripts/inject-install-sh.mjs` (static export has no server to honor
 * `redirects()`, and `redirects` is incompatible with `output: 'export'`).
 * The production build config is unchanged by this gating.
 */
const monorepoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  trailingSlash: true,
  outputFileTracingRoot: monorepoRoot,
  images: {
    unoptimized: true,
  },
  ...(isDev
    ? {
        redirects: async () => [
          // `en` is DEFAULT_LOCALE in content/index.ts. Dev-only parity with the
          // deployed root redirect; never reaches the static export build.
          { source: "/", destination: "/en", permanent: false },
        ],
      }
    : { output: "export" }),
};

export default nextConfig;
