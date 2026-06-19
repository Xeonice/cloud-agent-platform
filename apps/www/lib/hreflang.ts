/**
 * `hreflang` alternate-link helpers for the bilingual static export.
 *
 * The site exports one static HTML page per locale (D3). For SEO, each locale
 * page must advertise the other locale via `<link rel="alternate" hreflang>`
 * plus an `x-default` (per the marketing-www spec "SEO alternate locale hints").
 * Next's App Router consumes alternates through `Metadata.alternates.languages`;
 * raw `<link>` descriptors are also provided for any non-Next consumer.
 *
 * The absolute site origin is resolved at BUILD time from the canonical
 * build-time public config (`lib/site-config`, which reads `NEXT_PUBLIC_SITE_URL`
 * — the single env the metadata helpers and the installer template also use; the
 * integration step reconciled this with the i18n track's original
 * `NEXT_PUBLIC_SITE_DOMAIN`) so the published HTML carries real canonical URLs,
 * not placeholders. If the env is unset (e.g. local dev), helpers fall back to
 * relative, locale-prefixed paths so links still resolve against the current
 * origin.
 */
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_HREFLANG,
  type Locale,
} from "../content";
import { siteUrl } from "./site-config";

/** A single `<link rel="alternate" hreflang>` descriptor. */
export interface HreflangAlternate {
  /** The BCP-47 hreflang value (`"en"`, `"zh-Hans"`, or `"x-default"`). */
  readonly hrefLang: string;
  /** The alternate page URL (absolute when the site domain is known). */
  readonly href: string;
}

/**
 * The published site origin (no trailing slash), or `""` when unknown.
 * Delegates to the canonical {@link siteUrl} so every URL surface (canonical,
 * hreflang, OG) resolves against one env value.
 */
export function siteOrigin(): string {
  return siteUrl();
}

/**
 * Build the absolute (or origin-relative) URL for a locale's page.
 *
 * @param locale  The target locale.
 * @param path    The in-locale path BELOW the locale segment, e.g. "" for the
 *                landing root or "about". Leading/trailing slashes are tolerated.
 */
export function localeUrl(locale: Locale, path = ""): string {
  const clean = path.replace(/^\/+|\/+$/g, "");
  const suffix = clean ? `/${clean}` : "";
  const pathname = `/${locale}${suffix}`;
  const origin = siteOrigin();
  return origin ? `${origin}${pathname}` : pathname;
}

/**
 * The full set of `hreflang` alternates for a given page, INCLUDING the page's
 * own locale and an `x-default` pointing at {@link DEFAULT_LOCALE}.
 *
 * Per the spec, a locale page links to the *other* locale; we additionally
 * self-reference and emit `x-default`, which is the standard, search-engine
 * recommended shape.
 *
 * @param path  The in-locale path below the locale segment (see {@link localeUrl}).
 */
export function hreflangAlternates(path = ""): HreflangAlternate[] {
  const perLocale = LOCALES.map((locale) => ({
    hrefLang: LOCALE_HREFLANG[locale],
    href: localeUrl(locale, path),
  }));
  return [
    ...perLocale,
    { hrefLang: "x-default", href: localeUrl(DEFAULT_LOCALE, path) },
  ];
}

/**
 * The `languages` map for Next's `Metadata.alternates`. Keys are hreflang
 * values; values are the alternate URLs. Includes `x-default`.
 *
 * @example
 * export const metadata: Metadata = {
 *   alternates: { canonical: canonicalUrl(locale), languages: hreflangLanguages() },
 * };
 */
export function hreflangLanguages(path = ""): Record<string, string> {
  return Object.fromEntries(
    hreflangAlternates(path).map(({ hrefLang, href }) => [hrefLang, href]),
  );
}

/** The canonical (self) URL for a locale page — pair with the languages map. */
export function canonicalUrl(locale: Locale, path = ""): string {
  return localeUrl(locale, path);
}
