import { Injectable, Logger } from '@nestjs/common';

/**
 * Compatible-provider model-discovery HTTP boundary (account-settings, task 7.6).
 *
 * Lists the models a compatible OpenAI-style provider exposes at
 * `GET {baseUrl}/models` (Bearer-authenticated with the candidate API key). The
 * whole point is to validate a CANDIDATE provider configuration BEFORE it is
 * persisted, so this takes the base URL + key as arguments and persists nothing.
 *
 * The real network call cannot be exercised without a live provider, so the
 * pure CLASSIFICATION of the outcome (auth error vs unreachable vs malformed vs
 * ok) lives in {@link classifyModelDiscoveryOutcome} and is unit-testable under
 * plain `node`; this client only performs the `fetch` and feeds its result into
 * the classifier.
 */

/** A distinguishable model-discovery failure code surfaced to the console. */
export type ModelDiscoveryErrorCode =
  /** The provider rejected the credential (HTTP 401/403). (Re)enter the key. */
  | 'provider_auth_failed'
  /** The provider could not be reached (network/DNS/timeout) or returned 5xx. */
  | 'provider_unreachable'
  /** Reached the provider but the response was not a parseable model list. */
  | 'provider_bad_response';

/** A successful discovery: the available model ids the provider reported. */
export interface ModelDiscoverySuccess {
  readonly ok: true;
  readonly models: string[];
}

/** A failed discovery, carrying a DISTINGUISHABLE error code + human message. */
export interface ModelDiscoveryFailure {
  readonly ok: false;
  readonly error: ModelDiscoveryErrorCode;
  readonly message: string;
}

export type ModelDiscoveryResult = ModelDiscoverySuccess | ModelDiscoveryFailure;

/**
 * The minimal view of an HTTP outcome the classifier needs. The client fills
 * this from the real `fetch` result (or a thrown transport error); keeping it a
 * plain record lets the verify phase drive every branch directly without a
 * live provider.
 */
export interface ModelDiscoveryOutcome {
  /** True when the request never produced a response (DNS/connect/timeout). */
  readonly networkError?: boolean;
  /** The HTTP status the provider returned, when a response was received. */
  readonly status?: number;
  /** The parsed JSON body, when a 2xx response had a parseable body. */
  readonly body?: unknown;
}

/**
 * Pure classification of a model-discovery HTTP outcome into a distinguishable
 * result (task 7.6). Branches:
 *   - network error / no response ⇒ `provider_unreachable` (retry-able).
 *   - HTTP 401/403 ⇒ `provider_auth_failed` (the key/base URL is wrong).
 *   - other non-2xx (incl. 5xx) ⇒ `provider_unreachable`.
 *   - 2xx whose body has no extractable model id list ⇒ `provider_bad_response`.
 *   - 2xx with a `data[].id` (OpenAI-style) or `string[]` model list ⇒ ok.
 *
 * An empty-but-successful model list is a valid `ok` result (`models: []`), not
 * an error — distinct from a malformed body.
 */
export function classifyModelDiscoveryOutcome(
  outcome: ModelDiscoveryOutcome,
): ModelDiscoveryResult {
  if (outcome.networkError) {
    return {
      ok: false,
      error: 'provider_unreachable',
      message: 'Could not reach the provider (network, DNS, or timeout error).',
    };
  }
  const status = outcome.status ?? 0;
  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: 'provider_auth_failed',
      message: 'The provider rejected the API key (HTTP ' + status + ').',
    };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      error: 'provider_unreachable',
      message: 'The provider returned an unexpected status (HTTP ' + status + ').',
    };
  }
  const models = extractModelIds(outcome.body);
  if (models === null) {
    return {
      ok: false,
      error: 'provider_bad_response',
      message: 'The provider response did not contain a recognizable model list.',
    };
  }
  return { ok: true, models };
}

/**
 * Extracts model ids from a provider `GET /models` body. Supports the
 * OpenAI-style `{ data: [{ id }, ...] }` envelope and a bare `string[]`. Returns
 * `null` (malformed) when no recognizable list is present, and `[]` for an
 * explicitly empty-but-valid list. Pure.
 */
export function extractModelIds(body: unknown): string[] | null {
  if (Array.isArray(body)) {
    const ids = body.filter((m): m is string => typeof m === 'string');
    return ids.length === body.length ? ids : null;
  }
  if (body && typeof body === 'object' && 'data' in body) {
    const data = (body as { data: unknown }).data;
    if (Array.isArray(data)) {
      const ids: string[] = [];
      for (const entry of data) {
        if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
          ids.push((entry as { id: string }).id);
        } else {
          return null;
        }
      }
      return ids;
    }
  }
  return null;
}

/** Joins a provider base URL with the `/models` path, tolerating a trailing slash. */
export function modelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/models`;
}

@Injectable()
export class ModelDiscoveryClient {
  private readonly logger = new Logger(ModelDiscoveryClient.name);

  /**
   * Discovers the models a candidate compatible provider exposes, WITHOUT
   * persisting anything (task 7.6). Performs the authenticated `GET /models`
   * request and classifies the outcome via {@link classifyModelDiscoveryOutcome}
   * so provider errors are surfaced distinguishably (auth vs unreachable vs
   * malformed). The API key is used only as the request Bearer and is never
   * logged or returned.
   */
  async discover(baseUrl: string, apiKey: string): Promise<ModelDiscoveryResult> {
    let outcome: ModelDiscoveryOutcome;
    try {
      const response = await fetch(modelsEndpoint(baseUrl), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      outcome = { status: response.status, body };
    } catch (error) {
      this.logger.debug(
        `Model discovery transport error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      outcome = { networkError: true };
    }
    return classifyModelDiscoveryOutcome(outcome);
  }
}
