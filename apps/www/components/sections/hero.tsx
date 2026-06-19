import * as React from "react";

import { Button } from "@/components/button";
import { CommandBox } from "@/components/command-box";
import { Container } from "@/components/container";
import { Section } from "@/components/section";
import { TerminalDemo } from "@/components/terminal-demo";
import { FadeUp } from "@/components/motion";
import type { HeroContent, TerminalDemoContent } from "../../content";
import { resolveTokens, siteDomain } from "../../lib/site-config";

/**
 * Hero (task 4.1): headline + the `curl | sh` one-liner in a `CommandBox` with
 * copy, the inspectable script URL, and a disclosed manual `git clone && make up`
 * alternative — plus the static terminal demo. The `{domain}` / `{repo}` tokens
 * in the content are resolved against the build-time site config so the rendered
 * HTML carries real values, never placeholders.
 */
export function Hero({
  hero,
  terminal,
}: {
  hero: HeroContent;
  terminal: TerminalDemoContent;
}) {
  const installCommand = resolveTokens(hero.installCommand);
  const scriptUrl = `https://${siteDomain()}/install.sh`;

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
          <p className="mb-2 text-center font-mono text-xs uppercase tracking-widest text-muted">
            {hero.installLabel}
          </p>
          <CommandBox
            command={installCommand}
            copyLabel={hero.copyLabel}
            copiedLabel={hero.copiedLabel}
          />
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
            <a
              href={scriptUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="cursor-pointer text-muted underline-offset-4 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              {hero.inspectLabel}
            </a>
          </div>
        </FadeUp>

        <FadeUp delayMs={300} className="mx-auto mt-6 max-w-2xl">
          <details className="group rounded-lg border border-hairline bg-surface/60">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg">
              <span>{hero.manual.summary}</span>
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
                  {hero.manual.commands
                    .map((line) => resolveTokens(line))
                    .map((line, i) => (
                      <span key={i} className="block">
                        <span
                          aria-hidden="true"
                          className="select-none text-muted"
                        >
                          {"$ "}
                        </span>
                        {line}
                      </span>
                    ))}
                </code>
              </pre>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                {hero.manual.note}
              </p>
            </div>
          </details>
        </FadeUp>

        <FadeUp
          delayMs={360}
          className="mt-8 flex flex-wrap items-center justify-center gap-3"
        >
          <Button asChild size="lg">
            <a href={hero.primaryCta.href} className="cursor-pointer">
              {hero.primaryCta.label}
            </a>
          </Button>
          <Button asChild variant="outline" size="lg">
            <a href={hero.secondaryCta.href} className="cursor-pointer">
              {hero.secondaryCta.label}
            </a>
          </Button>
        </FadeUp>

        <FadeUp delayMs={420} className="mx-auto mt-16 max-w-3xl">
          <TerminalDemo caption={terminal.caption} lines={terminal.lines} />
        </FadeUp>
      </Container>
    </Section>
  );
}
