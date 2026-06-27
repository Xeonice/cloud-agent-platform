import * as React from "react";

import { CommandBox } from "@/components/command-box";
import { Container } from "@/components/container";
import { Section } from "@/components/section";
import { TerminalDemo } from "@/components/terminal-demo";
import { FadeUp } from "@/components/motion";
import { cn } from "@/lib/utils";
import type {
  ClaudeCodeInstallContent,
  HeroContent,
  ManualInstallContent,
  ScriptInstallContent,
  TerminalDemoContent,
} from "../../content";
import { resolveTokens, siteDomain } from "../../lib/site-config";

/**
 * Hero (task 4.1): headline + the "Get it running" install area, reorganized
 * into three scenario cards so a first visitor can tell at a glance which path
 * is theirs instead of decoding two near-identical `curl | sh` one-liners:
 *
 *   1. Let Claude Code deploy it (recommended) — a copyable natural-language
 *      prompt; Claude Code reads the installer, checks the host, and runs the
 *      platform-specific release-image flow.
 *   2. Install it yourself — the friendly `install.sh` release-image wrapper.
 *   3. Run quick-deploy directly — the same prebuilt path exposed for debugging.
 *
 * Each card leads with plain-language copy; the dense technical caveats live in
 * a short trial note + the disclosed manual `<details>`. The `{domain}` /
 * `{repo}` tokens are resolved against the build-time site config so the
 * rendered HTML carries real values, never placeholders.
 */
export function Hero({
  hero,
  terminal,
}: {
  hero: HeroContent;
  terminal: TerminalDemoContent;
}) {
  return (
    <Section
      id="install"
      className="relative overflow-hidden pt-28 sm:pt-32 lg:pt-36"
    >
      {/* decorative monochrome backdrop (grid + top radial glow) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-grid mask-fade-b opacity-60"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-radial-fade"
      />

      <Container>
        <div className="mx-auto max-w-3xl text-center">
          <FadeUp>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              {hero.eyebrow}
            </p>
          </FadeUp>
          <FadeUp delayMs={60}>
            <h1 className="mt-5 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              {hero.title}
            </h1>
          </FadeUp>
          <FadeUp delayMs={120}>
            <p className="mt-4 text-lg font-medium text-fg/90 text-balance">
              {hero.subtitle}
            </p>
          </FadeUp>
          <FadeUp delayMs={180}>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted text-pretty">
              {hero.description}
            </p>
          </FadeUp>
        </div>

        <FadeUp delayMs={240} className="mx-auto mt-10 max-w-2xl">
          <p className="mb-4 text-center font-mono text-xs uppercase tracking-widest text-muted">
            {hero.methodsHeading}
          </p>
          <div className="space-y-4">
            <ClaudeCodeCard
              method={hero.claudeCode}
              copiedLabel={hero.copiedLabel}
            />
            <ScriptCard
              method={hero.install}
              scriptUrl={`https://${siteDomain()}/install.sh`}
              copyLabel={hero.copyLabel}
              copiedLabel={hero.copiedLabel}
            />
            <ScriptCard
              method={hero.prebuilt}
              scriptUrl={`https://${siteDomain()}/quick-deploy.sh`}
              copyLabel={hero.copyLabel}
              copiedLabel={hero.copiedLabel}
            />
          </div>
          <div className="mt-6 text-center">
            <a
              href={hero.secondaryCta.href}
              className="cursor-pointer text-sm text-muted underline-offset-4 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              {hero.secondaryCta.label} →
            </a>
          </div>
        </FadeUp>

        <FadeUp delayMs={420} className="mx-auto mt-16 max-w-3xl">
          <TerminalDemo caption={terminal.caption} lines={terminal.lines} />
        </FadeUp>
      </Container>
    </Section>
  );
}

/** Shared card shell for the three install methods. */
function MethodCard({
  highlighted,
  children,
}: {
  highlighted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-surface/40 p-5 text-left",
        highlighted ? "border-fg/30 ring-1 ring-fg/10" : "border-hairline",
      )}
    >
      {children}
    </div>
  );
}

/** Card title + optional "Recommended" badge. */
function CardHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {badge && (
        <span className="rounded-full border border-fg/20 bg-fg/5 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-fg">
          {badge}
        </span>
      )}
    </div>
  );
}

/** Card 1: the recommended "let Claude Code deploy it" prompt. */
function ClaudeCodeCard({
  method,
  copiedLabel,
}: {
  method: ClaudeCodeInstallContent;
  copiedLabel: string;
}) {
  const prompt = resolveTokens(method.prompt);
  return (
    <MethodCard highlighted>
      <CardHeader title={method.title} badge={method.badge} />
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{method.blurb}</p>
      <div className="mt-3">
        <CommandBox
          multiline
          command={prompt}
          copyLabel={method.copyLabel}
          copiedLabel={copiedLabel}
        />
      </div>
    </MethodCard>
  );
}

/** Cards 2 & 3: a `curl | sh` script path with an inspect link + manual fallback. */
function ScriptCard({
  method,
  scriptUrl,
  copyLabel,
  copiedLabel,
}: {
  method: ScriptInstallContent;
  scriptUrl: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const command = resolveTokens(method.command);
  return (
    <MethodCard>
      <CardHeader title={method.title} />
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{method.blurb}</p>
      <div className="mt-3">
        <CommandBox
          command={command}
          copyLabel={copyLabel}
          copiedLabel={copiedLabel}
        />
      </div>
      {method.caveat && (
        <p className="mt-2 text-xs leading-relaxed text-muted text-pretty">
          {method.caveat}
        </p>
      )}
      <div className="mt-3 text-sm">
        <a
          href={scriptUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="cursor-pointer text-muted underline-offset-4 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {method.inspectLabel}
        </a>
      </div>
      <ManualDetails manual={method.manual} />
    </MethodCard>
  );
}

/** The disclosed manual command path, shared by the two script cards. */
function ManualDetails({ manual }: { manual: ManualInstallContent }) {
  return (
    <details className="group mt-3 rounded-lg border border-hairline bg-surface/60">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg">
        <span>{manual.summary}</span>
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-xs text-muted transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="border-t border-hairline px-4 py-3">
        <pre className="overflow-x-auto font-mono text-[13px] leading-relaxed text-fg">
          <code>
            {manual.commands
              .map((line) => resolveTokens(line))
              .map((line, i) => (
                <span key={i} className="block">
                  <span aria-hidden="true" className="select-none text-muted">
                    {"$ "}
                  </span>
                  {line}
                </span>
              ))}
          </code>
        </pre>
        <p className="mt-3 text-xs leading-relaxed text-muted">{manual.note}</p>
      </div>
    </details>
  );
}
