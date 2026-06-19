import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import "../globals.css";

import {
  CONTENT,
  LOCALES,
  LOCALE_HREFLANG,
  isLocale,
  type Locale,
} from "../../content";
import { canonicalUrl, hreflangLanguages } from "../../lib/hreflang";
import { siteUrl } from "../../lib/site-config";

/**
 * Locale-segmented root layout — the marketing site's ROOT layout lives under
 * the `[locale]` dynamic segment (Next.js i18n pattern, task 3.1). This is the
 * element that renders `<html>`/`<body>`, so it owns:
 *   - per-locale `<html lang>` (resolved from the route segment),
 *   - the Geist Sans + Geist Mono font classes (design.md D5 / task 2.1) — the
 *     `geist/font` package injects the `--font-geist-sans` / `--font-geist-mono`
 *     CSS vars on <html>, which globals.css maps onto `font-sans` / `font-mono`,
 *   - the global stylesheet import,
 *   - per-locale SEO/OG/Twitter metadata + hreflang alternates (task 2.4).
 *
 * `generateStaticParams` enumerates `en` + `zh` so the static export emits one
 * HTML tree per locale (D3); no runtime locale resolution.
 */
export function generateStaticParams(): Array<{ locale: Locale }> {
  return LOCALES.map((locale) => ({ locale }));
}

// Static export: only the enumerated locale params may be rendered.
export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const resolved: Locale = isLocale(locale) ? locale : "en";
  const content = CONTENT[resolved];
  const origin = siteUrl();
  const canonical = canonicalUrl(resolved);
  const ogImage = origin ? `${origin}/opengraph-image.png` : "/opengraph-image.png";

  return {
    // metadataBase lets Next resolve relative OG/canonical URLs to absolute ones
    // in the exported HTML when a site origin is configured.
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    title: content.meta.title,
    description: content.meta.description,
    alternates: {
      canonical,
      languages: hreflangLanguages(),
    },
    openGraph: {
      type: "website",
      siteName: "cloud-agent-platform",
      locale: LOCALE_HREFLANG[resolved],
      title: content.meta.title,
      description: content.meta.description,
      url: canonical,
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: content.meta.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: content.meta.title,
      description: content.meta.description,
      images: [ogImage],
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>): Promise<React.ReactElement> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <html lang={LOCALE_HREFLANG[locale]} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
