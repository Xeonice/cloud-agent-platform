import { Injectable, Logger } from '@nestjs/common';
import {
  assertSafeProviderUrl,
  UnsafeProviderUrlError,
  type HostResolver,
} from './assert-safe-provider-url';

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
  | 'provider_bad_response'
  /**
   * The base URL was rejected as unsafe BEFORE any outbound fetch (bad scheme,
   * or a host that resolves to loopback/private/link-local/metadata) — an SSRF
   * guard hit, not a provider failure (task 2.2 / design D4).
   */
  | 'provider_url_blocked';

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
  /**
   * True when the base URL was rejected by the SSRF guard before any fetch
   * (bad scheme or unsafe host). Distinct from `networkError`: no outbound
   * request was made at all.
   */
  readonly urlBlocked?: boolean;
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
  if (outcome.urlBlocked) {
    return {
      ok: false,
      error: 'provider_url_blocked',
      message:
        'The provider base URL was rejected as unsafe (scheme or host not ' +
        'allowed); no request was made.',
    };
  }
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

/**
 * Reads a `fetch` response body with a HARD size cap (task 2.2 / design D4): a
 * declared `content-length` over the cap short-circuits before reading a byte,
 * and the stream is otherwise drained chunk-by-chunk, aborting the moment the
 * accumulated size exceeds the cap so a provider claiming a small (or no)
 * content-length cannot stream an unbounded body into memory. Returns the
 * decoded text (≤ cap) or `null` when the cap was exceeded.
 */
async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  const body = response.body;
  if (!body) {
    // No stream (e.g. a HEAD-like empty body); fall back to the buffered text,
    // still bounded by the content-length check above.
    const text = await response.text();
    return Buffer.byteLength(text) > maxBytes ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

@Injectable()
export class ModelDiscoveryClient {
  private readonly logger = new Logger(ModelDiscoveryClient.name);

  /** Bounded request timeout so a slow/unresponsive provider cannot hang us. */
  private static readonly REQUEST_TIMEOUT_MS = 8_000;
  /** Hard cap on the discovery response body read before `JSON.parse` (1 MiB). */
  private static readonly MAX_BODY_BYTES = 1_048_576;

  /**
   * Discovers the models a candidate compatible provider exposes, WITHOUT
   * persisting anything (task 7.6). The operator-supplied base URL is first
   * validated by {@link assertSafeProviderUrl} (SSRF guard, task 2.2 / D4) — an
   * unsafe scheme/host is rejected with NO outbound fetch. The authenticated
   * `GET /models` request is then time-bounded ({@link AbortSignal.timeout}),
   * does NOT auto-follow redirects (`redirect: 'manual'`; a redirect target is
   * re-validated against the same host rules), and its body is read under a
   * hard size cap before `JSON.parse`. The outcome is classified via
   * {@link classifyModelDiscoveryOutcome} so failures are distinguishable
   * (blocked vs auth vs unreachable vs malformed). The API key is used only as
   * the request Bearer and is never logged or returned.
   *
   * `resolver` overrides host resolution for the SSRF guard (verify phase only).
   */
  async discover(
    baseUrl: string,
    apiKey: string,
    resolver?: HostResolver,
  ): Promise<ModelDiscoveryResult> {
    // SSRF guard BEFORE any network: an unsafe base URL never reaches fetch.
    try {
      await assertSafeProviderUrl(baseUrl, resolver);
    } catch (error) {
      if (error instanceof UnsafeProviderUrlError) {
        this.logger.warn(
          `Model discovery rejected an unsafe base URL (${error.code}).`,
        );
        return classifyModelDiscoveryOutcome({ urlBlocked: true });
      }
      throw error;
    }

    const outcome = await this.fetchModels(modelsEndpoint(baseUrl), apiKey, resolver);
    return classifyModelDiscoveryOutcome(outcome);
  }

  /**
   * Performs the bounded `GET {endpoint}` and, when the provider answers with a
   * manual redirect, re-validates the redirect target host before following it
   * ONCE — so an open-redirect cannot bounce the probe onto an internal host.
   */
  private async fetchModels(
    endpoint: string,
    apiKey: string,
    resolver: HostResolver | undefined,
    redirectsLeft = 3,
  ): Promise<ModelDiscoveryOutcome> {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(ModelDiscoveryClient.REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      });

      // `redirect: 'manual'` surfaces a 3xx as a real response (status 0/“opaque
      // redirect” in browsers; in Node fetch the 3xx + Location are visible).
      // Re-validate the redirect target against the SSRF rules before following.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirectsLeft <= 0) {
          return { networkError: true };
        }
        const target = new URL(location, endpoint).toString();
        try {
          await assertSafeProviderUrl(target, resolver);
        } catch (error) {
          if (error instanceof UnsafeProviderUrlError) {
            this.logger.warn(
              `Model discovery blocked a redirect to an unsafe host (${error.code}).`,
            );
            return { urlBlocked: true };
          }
          throw error;
        }
        return this.fetchModels(target, apiKey, resolver, redirectsLeft - 1);
      }

      const text = await readBoundedText(
        response,
        ModelDiscoveryClient.MAX_BODY_BYTES,
      );
      if (text === null) {
        // Oversized body: do not parse an unbounded response. Treat as a bad
        // response rather than ok.
        return { status: response.status, body: undefined };
      }
      let body: unknown;
      try {
        body = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: response.status, body };
    } catch (error) {
      this.logger.debug(
        `Model discovery transport error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { networkError: true };
    }
  }
}
