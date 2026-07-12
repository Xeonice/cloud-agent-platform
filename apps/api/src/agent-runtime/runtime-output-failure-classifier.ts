import type { RuntimeOutputFailure } from './agent-runtime.port';

/**
 * Remove terminal decoration that can split otherwise-stable CLI error text.
 * Escaped JSON quotes are normalized because headless JSON errors can themselves
 * be rendered inside a JSON/log string before reaching the PTY stream.
 */
export function normalizeRuntimeOutput(output: string): string {
  /* eslint-disable no-control-regex -- terminal output contains ANSI/C0 bytes by definition. */
  return output
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\\"/g, '"');
  /* eslint-enable no-control-regex */
}

/** Classify stable Codex authentication failures from a rolling output window. */
export function classifyCodexOutputFailure(
  rollingOutput: string,
): RuntimeOutputFailure | null {
  const output = normalizeRuntimeOutput(rollingOutput);
  const collapsed = collapseWhitespace(output);
  const has401 = /\b(?:http\s*)?401(?:\s+unauthorized)?\b/i.test(collapsed);
  const hasErrorEnvelope =
    /"error"\s*:\s*\{/i.test(output) ||
    /"type"\s*:\s*"error"/i.test(output) ||
    /(?:^|\n)\s*(?:turn error|error loading configuration|failed to refresh token)\s*:/im.test(
      output,
    );

  const explicitExpiredCode = /"code"\s*:\s*"token_expired"/i.test(output);
  const explicitExpiredMessage =
    /provided authentication token is expired\.?(?:\s+please try signing in again\.?)?/i.test(
      collapsed,
    );
  if (
    has401 &&
    hasErrorEnvelope &&
    (explicitExpiredCode || explicitExpiredMessage)
  ) {
    return { code: 'runtime_auth_expired' };
  }

  const explicitRejectedCode =
    /"code"\s*:\s*"(?:token_invalidated|refresh_token_reused|invalid_api_key)"/i.test(
      output,
    );
  const refreshRejected =
    /your access token could not be refreshed because (?:your refresh token was (?:already used|revoked)|you (?:have )?since logged out or signed in to another account)[^.]*\.?\s+please (?:log out and )?sign in again\.?/i.test(
      collapsed,
    );
  const refreshFailed =
    /(?:^|\n)\s*failed to refresh token\s*:\s*your access token could not be refreshed\.\s*please log out and sign in again\.?\s*(?:$|\n)/im.test(
      output,
    );
  const structuredRefreshFailed =
    /(?:^|\n)\s*\{\s*"type"\s*:\s*"error"\s*,\s*"message"\s*:\s*"your access token could not be refreshed\.\s*please log out and sign in again\.?"\s*\}\s*(?:$|\n)/im.test(
      output,
    );
  const rejectedProviderCredential =
    has401 &&
    hasErrorEnvelope &&
    (/"code"\s*:\s*"invalid_api_key"/i.test(output) ||
      /"type"\s*:\s*"authentication_error"/i.test(output)) &&
      /(?:invalid|incorrect) (?:api key|x-api-key|bearer token|authentication credentials)/i.test(
        collapsed,
      );

  if (
    (explicitRejectedCode && has401 && hasErrorEnvelope) ||
    (refreshRejected && (has401 || hasErrorEnvelope)) ||
    refreshFailed ||
    structuredRefreshFailed ||
    rejectedProviderCredential ||
    (has401 && hasErrorEnvelope && /\bmissing bearer\b/i.test(collapsed))
  ) {
    return { code: 'runtime_auth_rejected' };
  }

  return null;
}

/** Classify stable Claude Code authentication failures from a rolling output window. */
export function classifyClaudeOutputFailure(
  rollingOutput: string,
): RuntimeOutputFailure | null {
  const output = normalizeRuntimeOutput(rollingOutput);
  const collapsed = collapseWhitespace(output);
  const authEnvelope =
    /\bapi error\s*:\s*401\b/i.test(collapsed) &&
    /"error"\s*:\s*\{[\s\S]{0,512}?"type"\s*:\s*"authentication_error"/i.test(
      output,
    );

  if (
    hasStandaloneTerminalLine(
      output,
      /^(?:your )?session (?:has )?expired\.\s*please run \/login to sign in again\.?$/i,
    ) ||
    hasStandaloneTerminalLine(
      output,
      /^oauth refresh token is no longer valid(?:\s*[.:\u00b7-]\s*please run \/login(?: to sign in again)?\.?)?$/i,
    ) ||
    (authEnvelope && /\boauth token has expired\b/i.test(collapsed))
  ) {
    return { code: 'runtime_auth_expired' };
  }

  const rejectedMessage =
    /\b(?:invalid bearer token|invalid authentication credentials|invalid x-api-key|invalid api key)\b/i.test(
      collapsed,
    );
  if (
    hasStandaloneTerminalLine(
      output,
      /^not logged in(?:\s*[.\u00b7-]\s*)?please run \/login(?: to authenticate)?\.?$/i,
    ) ||
    hasStandaloneTerminalLine(
      output,
      /^invalid api key(?:\s*[.:\u00b7-]\s*|\s+)please run \/login(?: to (?:authenticate|sign in again))?\.?$/i,
    ) ||
    (authEnvelope && rejectedMessage)
  ) {
    return { code: 'runtime_auth_rejected' };
  }

  return null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Match a complete terminal status line, after removing only common visual
 * prefixes. Requiring the entire line prevents prose that merely quotes the CLI
 * message from becoming a task failure.
 */
function hasStandaloneTerminalLine(output: string, expected: RegExp): boolean {
  return output.split('\n').some((rawLine) => {
    const line = rawLine
      .trim()
      .replace(/^(?:[>!*-]|\u2022|\u25a0|\u23bf)\s*/u, '')
      .trim();
    return expected.test(line);
  });
}
