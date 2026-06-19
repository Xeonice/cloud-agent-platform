import { notFound } from "next/navigation";

import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { Hero } from "@/components/sections/hero";
import { Features } from "@/components/sections/features";
import { HowItWorks } from "@/components/sections/how-it-works";
import { Security } from "@/components/sections/security";
import { SelfHostCta } from "@/components/sections/self-host-cta";
import { CONTENT, LOCALES, isLocale, type Locale } from "../../content";

/**
 * The single long-form landing page (task 4.5) — assembled from the bilingual
 * content module in the spec-required order: Hero → Features → How-it-works →
 * Security → Self-host CTA, wrapped by the site nav + footer. The locale is the
 * route segment (i18n 3.1): `generateStaticParams` enumerates `en` + `zh` so
 * one static HTML page is exported per locale (D3), and the matching content
 * object is rendered server-side with no runtime translation fetch.
 */
export function generateStaticParams(): Array<{ locale: Locale }> {
  return LOCALES.map((locale) => ({ locale }));
}

export const dynamicParams = false;

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const content = CONTENT[locale];

  return (
    <>
      <SiteNav
        nav={content.nav}
        locale={locale}
        languageToggleLabel={content.languageToggleLabel}
      />
      <main id="main">
        <Hero hero={content.hero} terminal={content.terminal} />
        <Features features={content.features} />
        <HowItWorks howItWorks={content.howItWorks} />
        <Security security={content.security} />
        <SelfHostCta selfHost={content.selfHost} />
      </main>
      <SiteFooter footer={content.footer} />
    </>
  );
}
