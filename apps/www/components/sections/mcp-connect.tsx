import * as React from "react";

import { Container } from "@/components/container";
import { Section } from "@/components/section";
import { CommandBox } from "@/components/command-box";
import { FadeUp } from "@/components/motion";
import type { McpConnectContent } from "../../content";
import { resolveTokens } from "../../lib/site-config";

/**
 * MCP-connect section — how to point an MCP client (Cursor / Claude Desktop /
 * VS Code) at the platform's remote MCP server over Streamable HTTP. The `/mcp`
 * endpoint URL is resolved from the build-time `{apiDomain}` token (the API
 * host, NOT the site host — see `lib/site-config.ts`); the section documents
 * the connection and points to the console for minting a token. It mints
 * NOTHING here (a raw credential must never originate from the public static
 * page) and introduces no runtime backend call (the endpoint is a build-time
 * inlined string), so the site still renders fully offline.
 */
export function McpConnect({ mcpConnect }: { mcpConnect: McpConnectContent }) {
  const endpoint = resolveTokens(mcpConnect.endpoint);

  return (
    <Section id="mcp" className="border-t border-hairline">
      <Container>
        <div className="max-w-2xl">
          <FadeUp>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              {mcpConnect.eyebrow}
            </p>
          </FadeUp>
          <FadeUp delayMs={60}>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {mcpConnect.title}
            </h2>
          </FadeUp>
          <FadeUp delayMs={120}>
            <p className="mt-4 text-base leading-relaxed text-muted text-pretty">
              {mcpConnect.description}
            </p>
          </FadeUp>
        </div>

        <FadeUp delayMs={180} className="mt-10 max-w-2xl">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
            {mcpConnect.endpointLabel}
          </p>
          <CommandBox
            command={endpoint}
            copyLabel={mcpConnect.copyLabel}
            copiedLabel={mcpConnect.copiedLabel}
            prompt={null}
          />
        </FadeUp>

        <FadeUp delayMs={240} className="mt-8 grid max-w-2xl gap-4">
          <p className="font-mono text-xs uppercase tracking-widest text-muted">
            {mcpConnect.installLabel}
          </p>
          <div className="grid gap-2">
            <p className="text-sm font-semibold text-fg">
              {mcpConnect.directLabel}
            </p>
            <CommandBox
              command={resolveTokens(mcpConnect.directCommand)}
              copyLabel={mcpConnect.copyLabel}
              copiedLabel={mcpConnect.copiedLabel}
              prompt={null}
            />
          </div>
          <div className="grid gap-2">
            <p className="text-sm font-semibold text-fg">
              {mcpConnect.fallbackLabel}
            </p>
            <CommandBox
              command={resolveTokens(mcpConnect.fallbackCommand)}
              copyLabel={mcpConnect.copyLabel}
              copiedLabel={mcpConnect.copiedLabel}
              prompt={null}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted text-pretty">
            {mcpConnect.transportNote}
          </p>
        </FadeUp>

        <ol className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-3">
          {mcpConnect.steps.map((step, index) => (
            <FadeUp
              as="li"
              key={step.index}
              delayMs={Math.min(180 + index * 60, 360)}
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

        <FadeUp delayMs={360} className="mt-10 max-w-2xl">
          <p className="text-sm leading-relaxed text-muted text-pretty">
            {mcpConnect.tokenNote}
          </p>
          <a
            href={resolveTokens(mcpConnect.tokenCta.href)}
            className="mt-3 inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-fg underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            {mcpConnect.tokenCta.label}
            <span aria-hidden="true">→</span>
          </a>
        </FadeUp>
      </Container>
    </Section>
  );
}
