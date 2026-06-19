import * as React from "react";

import { Card, CardHeader, CardTitle, CardDescription } from "@/components/card";
import { Container } from "@/components/container";
import { Section } from "@/components/section";
import { FadeUp, Spotlight } from "@/components/motion";
import type { FeaturesContent } from "../../content";

/**
 * Features section (task 4.3) — the real, shipped capabilities as hairline
 * cards: per-task container isolation, byte-identical terminal, dual runtime
 * (Codex + Claude Code), GitHub import, history/audit/metrics, OAuth + hard
 * allowlist. Copy comes from the content module (capability-level, no roadmap).
 *
 * Each cell fades up on scroll (staggered) and lights up on hover with a
 * surface lift plus a cursor-follow `Spotlight` glow (Vercel-style), so the
 * grid feels alive without any continuous/decorative motion.
 */
export function Features({ features }: { features: FeaturesContent }) {
  return (
    <Section id="features">
      <Container>
        <div className="max-w-2xl">
          <FadeUp>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              {features.eyebrow}
            </p>
          </FadeUp>
          <FadeUp delayMs={60}>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {features.title}
            </h2>
          </FadeUp>
          <FadeUp delayMs={120}>
            <p className="mt-4 text-base leading-relaxed text-muted text-pretty">
              {features.description}
            </p>
          </FadeUp>
        </div>

        <ul className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
          {features.items.map((item, index) => (
            <FadeUp
              as="li"
              key={item.title}
              delayMs={Math.min(index * 60, 300)}
              className="bg-bg"
            >
              <Spotlight className="h-full transition-colors duration-200 hover:bg-surface">
                <Card className="h-full rounded-none border-0 bg-transparent">
                  <CardHeader>
                    <CardTitle className="text-base">{item.title}</CardTitle>
                    <CardDescription className="mt-2">
                      {item.body}
                    </CardDescription>
                  </CardHeader>
                </Card>
              </Spotlight>
            </FadeUp>
          ))}
        </ul>
      </Container>
    </Section>
  );
}
