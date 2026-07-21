import { Injectable, Logger } from '@nestjs/common';

/**
 * Save-time Claude credential verification probe
 * (fix-claude-onboarding-and-token-verify, design D3).
 *
 * Exercises a candidate credential against the FIXED Anthropic API host before
 * it is persisted, so an invalid paste is caught in Settings instead of minutes
 * later inside a task (where it previously hung the task un-classified). The
 * host is a constant — unlike the compatible-provider discovery there is no
 * operator-supplied URL, so no SSRF surface and no `assertSafeProviderUrl` hop.
 *
 * The probe is deliberately ZERO-COST: it POSTs an empty body, which Anthropic
 * rejects with HTTP 400 AFTER authentication passes. Authentication is checked
 * first, so:
 *   - 401/403  → the credential itself is rejected (`rejected`);
 *   - any other HTTP response (400 body complaint, 2xx, 404, 429) → the
 *     credential passed authentication (`accepted`), no tokens consumed;
 *   - timeout / DNS / connect failure / 5xx → `indeterminate` — restricted-
 *     egress self-hosts must not be blocked from saving, and the task-time
 *     output classifier remains the backstop.
 *
 * The 401 shape was captured live in the incident (a stored setup-token
 * Anthropic rejects with `authentication_error: Invalid bearer token`).
 *
 * SECRET BOUNDARY: the credential is placed ONLY on the outbound auth header
 * and never logged, echoed, or included in the outcome.
 */

/** How a save-time probe concluded. */
export type ClaudeCredentialProbeOutcome =
  | 'accepted'
  | 'rejected'
  | 'indeterminate';

/** Fixed probe endpoint — auth is checked before body validation. */
export const ANTHROPIC_PROBE_URL = 'https://api.anthropic.com/v1/messages';

/** Single-attempt timeout (design D3: ~10 s, no retry storm on save). */
export const PROBE_TIMEOUT_MS = 10_000;

/** Classify a probe HTTP status (pure, unit-testable without a network). */
export function classifyProbeStatus(
  status: number,
): ClaudeCredentialProbeOutcome {
  if (status === 401 || status === 403) return 'rejected';
  if (status >= 500) return 'indeterminate';
  return 'accepted';
}

@Injectable()
export class ClaudeCredentialProbe {
  private readonly logger = new Logger(ClaudeCredentialProbe.name);

  async probe(
    mode: 'subscription' | 'api_key',
    secret: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ClaudeCredentialProbeOutcome> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (mode === 'subscription') {
      // `claude setup-token` OAuth token — the same bearer + beta header shape
      // the live incident curl used.
      headers['authorization'] = `Bearer ${secret}`;
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else {
      headers['x-api-key'] = secret;
    }
    try {
      const response = await fetchImpl(ANTHROPIC_PROBE_URL, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: 'error',
      });
      const outcome = classifyProbeStatus(response.status);
      this.logger.debug(
        `claude credential probe (${mode}) → HTTP ${response.status} (${outcome})`,
      );
      return outcome;
    } catch {
      // Timeout, DNS failure, refused connection, unexpected redirect — the
      // probe could not conclude; never block the save on reachability.
      this.logger.warn(
        `claude credential probe (${mode}) could not reach Anthropic; verification is indeterminate`,
      );
      return 'indeterminate';
    }
  }
}
