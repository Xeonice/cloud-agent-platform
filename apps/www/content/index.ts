/**
 * Bilingual content registry + the typed content contract.
 *
 * The marketing site (`apps/www`) is statically exported per locale (D3): the
 * locale is resolved at build time and the matching `SiteContent` object is
 * rendered into static HTML — there is NO runtime translation fetch. This module
 * is the single source of truth for both the content *shape* (`SiteContent` and
 * its sub-types) and the per-locale copy (`en` / `zh`).
 *
 * Adding a locale is intentionally additive: define a new `SiteContent` object
 * in `content/<locale>.ts`, then register it here. `LOCALES` drives
 * `generateStaticParams` (i18n 3.1) and the language toggle (3.3); the
 * `SiteContent` contract guarantees every locale covers every section so a
 * missing string is a *compile-time* error, never a blank slot at build.
 */
import { en } from "./en";
import { zh } from "./zh";

/** The locales the site is exported for. Order = display order in the toggle. */
export const LOCALES = ["en", "zh"] as const;

/** A single supported UI locale (`"en" | "zh"`). */
export type Locale = (typeof LOCALES)[number];

/** Locale rendered when no (or an unknown) locale segment is present. */
export const DEFAULT_LOCALE: Locale = "en";

/** Narrow an arbitrary string to a known {@link Locale}, else `undefined`. */
export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** BCP-47 language tag for a locale (used for `<html lang>` + `hreflang`). */
export const LOCALE_HREFLANG: Record<Locale, string> = {
  en: "en",
  zh: "zh-Hans",
};

/** Human-readable label for a locale (the language's own endonym). */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  zh: "中文",
};

// ---------------------------------------------------------------------------
// Content contract — every locale's `SiteContent` must cover every field.
// ---------------------------------------------------------------------------

/** A primary/secondary call-to-action link (label + target href). */
export interface CtaLink {
  readonly label: string;
  readonly href: string;
}

/** Top nav: in-page anchor links + the console entry + a primary CTA. */
export interface NavContent {
  /** In-page anchor links (e.g. `#features`). */
  readonly links: readonly CtaLink[];
  /** Link into the running console (cross-origin; degrades gracefully). */
  readonly console: CtaLink;
  /** The primary nav CTA (e.g. "Self-host"). */
  readonly cta: CtaLink;
}

/** The disclosed manual `git clone && make up` alternative to `curl | sh`. */
export interface ManualInstallContent {
  /** Short framing line ("Prefer to read it first?"). */
  readonly summary: string;
  /** The shell commands, one per line, for the manual path. */
  readonly commands: readonly string[];
  /** Note that `make up` is the source of truth the installer wraps. */
  readonly note: string;
}

/**
 * The second, prebuilt-image one-liner (`quick-deploy.sh`): pulls published images
 * with no GitHub OAuth. Presented alongside the source-build installer with its
 * caveats (amd64-only, legacy-token not production, host-root, localhost-only web).
 */
export interface PrebuiltInstallContent {
  /** Label above the prebuilt command block. */
  readonly label: string;
  /** The prebuilt one-line command (the `{domain}` token is filled at build). */
  readonly command: string;
  /** Label for the inspectable quick-deploy.sh URL link. */
  readonly inspectLabel: string;
  /** One-line caveat: amd64-only, legacy-token (not OAuth-first prod), host-root, localhost web. */
  readonly caveat: string;
  /** The disclosed manual alternative (download compose, run the prebuilt compose) so a
   *  visitor is not required to pipe the prebuilt script to a shell. */
  readonly manual: ManualInstallContent;
}

/** Hero: headline, the one-liner install command, and the manual alternative. */
export interface HeroContent {
  readonly eyebrow: string;
  readonly title: string;
  /** Emphasized sub-line under the title. */
  readonly subtitle: string;
  readonly description: string;
  /** Label above the `curl | sh` command block. */
  readonly installLabel: string;
  /** The one-line install command (the `{domain}` token is filled at build). */
  readonly installCommand: string;
  /** Accessible label for the copy-to-clipboard control. */
  readonly copyLabel: string;
  /** Confirmation shown after a successful copy. */
  readonly copiedLabel: string;
  /** Label for the inspectable script URL link. */
  readonly inspectLabel: string;
  readonly manual: ManualInstallContent;
  /** The prebuilt-image, no-OAuth second one-liner (quick-deploy.sh). */
  readonly prebuilt: PrebuiltInstallContent;
  readonly primaryCta: CtaLink;
  readonly secondaryCta: CtaLink;
}

/** A static terminal-demo line (re-implements the RunnerCapsule concept). */
export interface TerminalLine {
  /** Visual role of the line, drives styling (no backend stream). */
  readonly kind: "prompt" | "output" | "comment";
  readonly text: string;
}

/** The static terminal demo block under/beside the hero. */
export interface TerminalDemoContent {
  /** Window chrome / title bar caption. */
  readonly caption: string;
  readonly lines: readonly TerminalLine[];
}

/** A single feature card (title + supporting copy). */
export interface FeatureItem {
  readonly title: string;
  readonly body: string;
}

/** The Features section: heading + the capability cards. */
export interface FeaturesContent {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly items: readonly FeatureItem[];
}

/** A numbered how-it-works step. */
export interface HowItWorksStep {
  readonly index: string;
  readonly title: string;
  readonly body: string;
}

/** The How-it-works section: heading + ordered steps. */
export interface HowItWorksContent {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly HowItWorksStep[];
}

/** A single MCP-client connect step (a numbered how-to row). */
export interface McpConnectStep {
  readonly index: string;
  readonly title: string;
  readonly body: string;
}

/**
 * The MCP-connect section: how to point an MCP client (Cursor / Claude Desktop
 * / VS Code) at the platform's remote MCP server over Streamable HTTP. The
 * `endpoint` carries the `{apiDomain}` build-time token (the API host, NOT the
 * site host); the section documents the connection but mints no token (tokens
 * are minted in the console settings page).
 */
export interface McpConnectContent {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  /** Label above the endpoint command block. */
  readonly endpointLabel: string;
  /** The `/mcp` endpoint URL, carrying the `{apiDomain}` build-time token. */
  readonly endpoint: string;
  /** Accessible label for the endpoint copy control. */
  readonly copyLabel: string;
  /** Confirmation shown after a successful copy. */
  readonly copiedLabel: string;
  /** Label above the concrete install-command block. */
  readonly installLabel: string;
  /** Label for command A (direct streamable-HTTP). */
  readonly directLabel: string;
  /** The direct `claude mcp add --transport http` command (carries `{apiDomain}`). */
  readonly directCommand: string;
  /** Label for command B (the `npx mcp-remote` stdio bridge). */
  readonly fallbackLabel: string;
  /** The `npx mcp-remote` fallback command (carries `{apiDomain}`). */
  readonly fallbackCommand: string;
  /** One-line note distinguishing stdio (local) from streamable HTTP (remote). */
  readonly transportNote: string;
  /** Ordered client-setup steps. */
  readonly steps: readonly McpConnectStep[];
  /** The "mint your token in the console" pointer (no mint control here). */
  readonly tokenNote: string;
  /** Link to where the token is minted (the console / self-host section). */
  readonly tokenCta: CtaLink;
}

/** A single honest security disclosure row. */
export interface SecurityPoint {
  readonly title: string;
  readonly body: string;
}

/** The Security section: honest about the host-root boundary. */
export interface SecurityContent {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly points: readonly SecurityPoint[];
}

/** The closing Self-host call-to-action band. */
export interface SelfHostContent {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly primaryCta: CtaLink;
  readonly secondaryCta: CtaLink;
}

/** The footer: tagline + grouped links. */
export interface FooterContent {
  readonly tagline: string;
  readonly links: readonly CtaLink[];
  /** Copyright / legal line. */
  readonly legal: string;
}

/** The complete, typed copy for one locale. */
export interface SiteContent {
  /** `<title>` + meta description copy live here so metadata is per-locale. */
  readonly meta: {
    readonly title: string;
    readonly description: string;
  };
  /** Accessible name for the language toggle control. */
  readonly languageToggleLabel: string;
  readonly nav: NavContent;
  readonly hero: HeroContent;
  readonly terminal: TerminalDemoContent;
  readonly features: FeaturesContent;
  readonly howItWorks: HowItWorksContent;
  readonly mcpConnect: McpConnectContent;
  readonly security: SecurityContent;
  readonly selfHost: SelfHostContent;
  readonly footer: FooterContent;
}

/** Locale → content. Indexable by a {@link Locale} for static rendering. */
export const CONTENT: Record<Locale, SiteContent> = {
  en,
  zh,
};

/** Resolve a locale's content, falling back to {@link DEFAULT_LOCALE}. */
export function getContent(locale: string): SiteContent {
  return isLocale(locale) ? CONTENT[locale] : CONTENT[DEFAULT_LOCALE];
}

export { en, zh };
