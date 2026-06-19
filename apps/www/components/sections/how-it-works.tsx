import * as React from "react";

import { Container } from "@/components/container";
import { Section } from "@/components/section";
import { FadeUp } from "@/components/motion";
import type { HowItWorksContent } from "../../content";

/**
 * How-it-works section (task 4.4) — the five honest steps (clone → install →
 * log in → create task → watch terminal) as a numbered list. No bespoke
 * provisioning is implied; the installer wraps the same `make up` flow.
 */
export function HowItWorks({ howItWorks }: { howItWorks: HowItWorksContent }) {
  return (
    <Section id="how-it-works" className="border-t border-hairline">
      <Container>
        <div className="max-w-2xl">
          <FadeUp>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              {howItWorks.eyebrow}
            </p>
          </FadeUp>
          <FadeUp delayMs={60}>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {howItWorks.title}
            </h2>
          </FadeUp>
          <FadeUp delayMs={120}>
            <p className="mt-4 text-base leading-relaxed text-muted text-pretty">
              {howItWorks.description}
            </p>
          </FadeUp>
        </div>

        <ol className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-5">
          {howItWorks.steps.map((step, index) => (
            <FadeUp
              as="li"
              key={step.index}
              delayMs={Math.min(index * 60, 300)}
              className="group relative"
            >
              <span
                aria-hidden="true"
                className="mb-5 block h-px w-8 bg-hairline transition-all duration-300 ease-out group-hover:w-14 group-hover:bg-fg/40"
              />
              <span className="font-mono text-sm font-semibold text-muted transition-colors duration-200 group-hover:text-fg">
                {step.index}
              </span>
              <h3 className="mt-3 text-base font-semibold tracking-tight text-fg">
                {step.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {step.body}
              </p>
            </FadeUp>
          ))}
        </ol>
      </Container>
    </Section>
  );
}
