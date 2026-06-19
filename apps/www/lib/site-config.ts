/**
 * Canonical build-time public config for the marketing site (`@cap/www`).
 *
 * Integration seam (tasks 2.4 / 3.1 / 5.3): the parallel tracks each reached for
 * a slightly different env name (scaffolding's `.env.example` documents
 * `NEXT_PUBLIC_SITE_URL` + `NEXT_PUBLIC_REPO_URL`; the i18n hreflang helper read
 * `NEXT_PUBLIC_SITE_DOMAIN`; the content modules embed `{domain}` / `{repo}`
 * tokens). This module is the SINGLE source of truth that reconciles them:
 *   - SEO/OG metadata (canonical + OG URLs)            → `siteUrl()`
 *   - hreflang alternates                              → `siteUrl()`
 *   - the Hero `curl | sh` command + footer/repo links → `siteDomain()` / `repo*`
 *   - the build-time `install.sh` template injection    (5.3, build script)
 *
 * Values are read from `process.env.NEXT_PUBLIC_*` at module load so they are
 * inlined into the static export (`output: 'export'`, design D6). They fall back
 * to safe local-dev defaults when unset so the site still builds and renders.
 */

const DEFAULT_REPO_URL = "https://github.com/Xeonice/cloud-agent-platform";

/** Strip a trailing `.git` and any trailing slashes from a repo URL. */
function normalizeRepoUrl(raw: string): string {
  return raw.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
}

/**
 * The full published site origin (scheme + host, no trailing slash), e.g.
 * `https://example.com`. Empty string when unset so callers can fall back to
 * origin-relative URLs in local dev.
 */
export function siteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * The bare site host (no scheme, no trailing slash), e.g. `example.com`. Used in
 * the Hero `curl -fsSL https://<domain>/install.sh | sh` one-liner. Falls back
 * to a readable placeholder when the site URL is unset.
 */
export function siteDomain(): string {
  const url = siteUrl();
  if (!url) return "your-domain.example";
  return url.replace(/^https?:\/\//i, "");
}

/** The full public repository URL (no trailing `.git`), e.g. for footer links. */
export function repoUrl(): string {
  const raw = process.env.NEXT_PUBLIC_REPO_URL?.trim();
  return normalizeRepoUrl(raw || DEFAULT_REPO_URL);
}

/**
 * The `owner/name` slug of the public repo (e.g. `Xeonice/cloud-agent-platform`),
 * used to fill the `{repo}` token in the bilingual content (clone commands,
 * GitHub links).
 */
export function repoSlug(): string {
  return repoUrl().replace(/^https?:\/\/github\.com\//i, "");
}

/**
 * Resolve the `{domain}` / `{repo}` tokens the content modules embed (the
 * one-line install command and the `git clone` URL / GitHub links) against the
 * build-time config, so the rendered HTML carries real values — never the raw
 * tokens.
 */
export function resolveTokens(text: string): string {
  return text
    .replaceAll("{domain}", siteDomain())
    .replaceAll("{repo}", repoSlug());
}
