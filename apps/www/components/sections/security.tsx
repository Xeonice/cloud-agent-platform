import * as React from "react";

import { CardTitle, CardDescription } from "@/components/card";
import { Container } from "@/components/container";
import { Section } from "@/components/section";
import { FadeUp, Spotlight } from "@/components/motion";
import type { SecurityContent } from "../../content";

/**
 * Security section (task 4.4) — HONEST about the host-root boundary: tasks run
 * host-root via `docker.sock` ("who can log in = who can run as root on the
 * host"), fail-closed allowlist, the write gate, and the auditable install path.
 * The copy must disclose the caveat rather than omit it (marketing-www spec).
 *
 * Each disclosure is a `Spotlight` card: it fades up on scroll and, on hover,
 * brightens its hairline and shows a cursor-follow glow — additive polish only,
 * no continuous motion.
 */
export function Security({ security }: { security: SecurityContent }) {
  return (
    <Section id="security" className="border-t border-hairline">
      <Container>
        <div className="max-w-2xl">
          <FadeUp>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              {security.eyebrow}
            </p>
          </FadeUp>
          <FadeUp delayMs={60}>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {security.title}
            </h2>
          </FadeUp>
          <FadeUp delayMs={120}>
            <p className="mt-4 text-base leading-relaxed text-muted text-pretty">
              {security.description}
            </p>
          </FadeUp>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {security.points.map((point, index) => (
            <FadeUp key={point.title} delayMs={Math.min(index * 60, 240)}>
              <Spotlight className="h-full rounded-xl border border-hairline bg-surface transition-colors duration-200 hover:border-fg/20">
                <div className="flex flex-col gap-1.5 p-6">
                  <CardTitle className="text-base">{point.title}</CardTitle>
                  <CardDescription className="mt-2">
                    {point.body}
                  </CardDescription>
                </div>
              </Spotlight>
            </FadeUp>
          ))}
        </div>
      </Container>
    </Section>
  );
}
