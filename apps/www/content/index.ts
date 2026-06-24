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
 * The "let Claude Code deploy it" card — the recommended, lowest-friction path.
 * Instead of a shell command, it offers a natural-language `prompt` the visitor
 * pastes into Claude Code, which then reads the installer, checks the host,
 * walks them through GitHub OAuth, and brings the source-build stack up. The
 * `prompt` carries the `{domain}` / `{repo}` build-time tokens.
 */
export interface ClaudeCodeInstallContent {
  /** Card title (e.g. "Let Claude Code deploy it"). */
  readonly title: string;
  /** Short badge marking this as the recommended path (e.g. "Recommended"). */
  readonly badge: string;
  /** One-line, plain-language blurb of what Claude Code will do. */
  readonly blurb: string;
  /** The multi-line prompt to paste into Claude Code (carries `{domain}`/`{repo}`). */
  readonly prompt: string;
  /** Accessible label for the copy-the-prompt control. */
  readonly copyLabel: string;
}

/**
 * A script-based install card (`curl | sh`): the source-build `install.sh`
 * (OAuth-first production path) or the prebuilt `quick-deploy.sh` (no-OAuth
 * local trial). Each leads with a plain-language `title`/`blurb` so a visitor
 * can tell which one is for them, keeps the inspectable script link, and
 * discloses the equivalent manual path. `caveat` is the prebuilt-only trial
 * warning (omitted for the source-build card). Commands carry the `{domain}` /
 * `{repo}` build-time tokens.
 */
export interface ScriptInstallContent {
  /** Plain-language card title (e.g. "Install it yourself"). */
  readonly title: string;
  /** One-line blurb of who this path is for. */
  readonly blurb: string;
  /** The one-line command (the `{domain}` token is filled at build). */
  readonly command: string;
  /** Label for the inspectable script URL link. */
  readonly inspectLabel: string;
  /** The disclosed manual alternative so piping to a shell is never required. */
  readonly manual: ManualInstallContent;
  /** Optional short trial-only caveat (prebuilt card); omit for the source build. */
  readonly caveat?: string;
}

/**
 * Hero: headline plus the "Get it running" install area, reorganized into three
 * scenario cards — let Claude Code deploy it (recommended), install it yourself
 * (source build + OAuth), or just try it fast (prebuilt, no OAuth) — so a first
 * visitor can tell at a glance which path is theirs.
 */
export interface HeroContent {
  readonly eyebrow: string;
  readonly title: string;
  /** Emphasized sub-line under the title. */
  readonly subtitle: string;
  readonly description: string;
  /** Heading above the three install-method cards (e.g. "Get it running"). */
  readonly methodsHeading: string;
  /** Accessible label for the copy-to-clipboard control on the command cards. */
  readonly copyLabel: string;
  /** Confirmation shown after a successful copy (shared by all cards). */
  readonly copiedLabel: string;
  /** Card 1: the recommended "let Claude Code deploy it" prompt. */
  readonly claudeCode: ClaudeCodeInstallContent;
  /** Card 2: the source-build `install.sh` (OAuth-first production) path. */
  readonly install: ScriptInstallContent;
  /** Card 3: the prebuilt `quick-deploy.sh` (no-OAuth local trial) path. */
  readonly prebuilt: ScriptInstallContent;
  /** Quiet secondary link under the cards (e.g. "See how it works"). */
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
