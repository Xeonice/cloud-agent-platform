import * as React from "react";

import { Button } from "@/components/button";
import { Container } from "@/components/container";
import { Section } from "@/components/section";
import { FadeUp } from "@/components/motion";
import type { SelfHostContent } from "../../content";
import { resolveTokens } from "../../lib/site-config";

/**
 * Self-host CTA (task 4.5) — the closing call-to-action band. Reinforces the
 * "runs on your own infrastructure, no telemetry" message and points back at
 * the install command + the manual setup. CTA hrefs may carry `{repo}` (e.g. a
 * GitHub link), resolved at build.
 */
export function SelfHostCta({ selfHost }: { selfHost: SelfHostContent }) {
  return (
    <Section id="self-host" className="border-t border-hairline">
      <Container>
        <FadeUp className="relative mx-auto max-w-3xl overflow-hidden rounded-2xl border border-hairline bg-surface px-6 py-16 text-center sm:px-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 bg-radial-fade"
          />
          <p className="font-mono text-xs uppercase tracking-widest text-muted">
            {selfHost.eyebrow}
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {selfHost.title}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted text-pretty">
            {selfHost.description}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <a
                href={resolveTokens(selfHost.primaryCta.href)}
                className="cursor-pointer"
              >
                {selfHost.primaryCta.label}
              </a>
            </Button>
            <Button asChild variant="outline" size="lg">
              <a
                href={resolveTokens(selfHost.secondaryCta.href)}
                className="cursor-pointer"
              >
                {selfHost.secondaryCta.label}
              </a>
            </Button>
          </div>
        </FadeUp>
      </Container>
    </Section>
  );
}
