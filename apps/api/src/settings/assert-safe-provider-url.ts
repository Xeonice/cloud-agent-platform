import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for operator-supplied compatible-provider Base URLs
 * (wire-compatible-provider-execution, task 2.1 / design D4).
 *
 * A compatible-provider Base URL is attacker-influenced (any allowlisted
 * operator types it in) and is fetched server-side by the discovery probe
 * (`model-discovery.client.ts`) and, at provision time, written into the codex
 * `config.toml` the sandbox uses to reach the provider. Without a guard the
 * endpoint becomes a Server-Side Request Forgery (SSRF) vector: an operator
 * could point it at `http://169.254.169.254/` (cloud metadata),
 * `http://localhost:6379` (an internal Redis), or a `file:`/`gopher:` URL.
 *
 * {@link assertSafeProviderUrl} is the single chokepoint shared by discovery
 * and execution: it requires an `http`/`https` scheme and resolves the host,
 * rejecting any address that is loopback, private, link-local, unique-local
 * (ULA), the unspecified address (`0.0.0.0`/`::`), or cloud metadata
 * (`169.254.169.254`). It performs NO outbound request to the provider — only a
 * DNS lookup of the host (skipped when the host is already a literal IP) — so a
 * rejected URL never triggers a fetch to the unsafe host.
 *
 * The address classification ({@link isUnsafeAddress}) is a PURE function of an
 * IP string, so the verify phase can drive every reject branch without DNS.
 */

/** A blocked provider URL, carrying a stable machine code + human reason. */
export class UnsafeProviderUrlError extends Error {
  constructor(
    /** A stable code distinguishing WHY the URL was rejected. */
    readonly code: UnsafeProviderUrlCode,
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeProviderUrlError';
  }
}

/** The distinguishable reasons a provider URL is rejected before any fetch. */
export type UnsafeProviderUrlCode =
  /** The string did not parse as a URL at all. */
  | 'malformed_url'
  /** The scheme was not `http`/`https` (e.g. `file:`, `gopher:`, `data:`). */
  | 'unsupported_scheme'
  /** The URL had no host (e.g. `file:///etc/passwd`). */
  | 'missing_host'
  /** The host resolved (or was a literal) to a loopback/private/metadata IP. */
  | 'unsafe_host';

/**
 * The function the host-resolution step uses to map a hostname to its IP
 * addresses. Defaulted to `node:dns/promises` `lookup`; overridable so the
 * verify phase can assert "no outbound fetch" without real DNS, and so callers
 * could later pin a resolved IP for connect.
 */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

const defaultResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/**
 * Validates an operator-supplied provider Base URL for SSRF safety, throwing
 * {@link UnsafeProviderUrlError} (which the caller maps to a clear discovery
 * failure) when it is unsafe. On success returns the parsed `URL`.
 *
 * Order of checks (cheapest / no-network first, so an unsafe URL never reaches
 * DNS let alone an outbound fetch):
 *   1. parseable as a URL, else `malformed_url`;
 *   2. scheme ∈ {http, https}, else `unsupported_scheme` (blocks file/gopher/…);
 *   3. a non-empty host, else `missing_host`;
 *   4. a literal-IP host is classified directly; a hostname is DNS-resolved and
 *      EVERY resolved address must be safe (a single unsafe answer rejects the
 *      whole host so a name that resolves to a mix cannot smuggle an internal
 *      target). Unsafe ⇒ `unsafe_host`.
 */
export async function assertSafeProviderUrl(
  baseUrl: string,
  resolver: HostResolver = defaultResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new UnsafeProviderUrlError(
      'malformed_url',
      'The provider base URL is not a valid URL.',
    );
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new UnsafeProviderUrlError(
      'unsupported_scheme',
      `The provider base URL scheme must be http or https (got "${scheme}").`,
    );
  }

  // `url.hostname` strips the brackets from an IPv6 literal (`[::1]` -> `::1`).
  const host = url.hostname;
  if (host.length === 0) {
    throw new UnsafeProviderUrlError(
      'missing_host',
      'The provider base URL has no host.',
    );
  }

  // A literal IP host is classified directly — no DNS, so a literal metadata /
  // loopback target is rejected without any network call at all.
  if (isIP(host) !== 0) {
    if (isUnsafeAddress(host)) {
      throw new UnsafeProviderUrlError(
        'unsafe_host',
        `The provider base URL host ${host} is not an allowed address.`,
      );
    }
    return url;
  }

  const addresses = await resolver(host);
  if (addresses.length === 0) {
    throw new UnsafeProviderUrlError(
      'unsafe_host',
      `The provider base URL host ${host} did not resolve to any address.`,
    );
  }
  for (const address of addresses) {
    if (isUnsafeAddress(address)) {
      throw new UnsafeProviderUrlError(
        'unsafe_host',
        `The provider base URL host ${host} resolves to a disallowed address.`,
      );
    }
  }
  return url;
}

/**
 * Pure classification of a single IP literal as SSRF-unsafe. Returns `true`
 * when the address is loopback, private (RFC1918 / RFC4193 ULA), link-local,
 * the unspecified address, or cloud metadata — i.e. anything that must not be
 * reachable through an operator-supplied provider URL. A non-IP string is
 * treated as unsafe (defensive: the caller only passes literals / resolved
 * addresses).
 */
export function isUnsafeAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isUnsafeIpv4(address);
  }
  if (family === 6) {
    return isUnsafeIpv6(address);
  }
  return true;
}

/** Classifies an IPv4 literal against the SSRF-blocked ranges. */
function isUnsafeIpv4(address: string): boolean {
  const parts = address.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  // 0.0.0.0/8 — "this host" / unspecified.
  if (a === 0) return true;
  // 10.0.0.0/8 — private.
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes 169.254.169.254 cloud metadata).
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private.
  if (a === 192 && b === 168) return true;
  return false;
}

/** Classifies an IPv6 literal against the SSRF-blocked ranges. */
function isUnsafeIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  // Unspecified `::` and loopback `::1`.
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) — defer to
  // the embedded IPv4 classification so a mapped metadata/loopback is caught.
  const mapped = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    return isUnsafeIpv4(mapped[1]);
  }
  // fc00::/7 — unique-local (ULA): first byte 0xfc or 0xfd.
  if (/^f[cd]/.test(lower)) return true;
  // fe80::/10 — link-local: fe8x..febx.
  if (/^fe[89ab]/.test(lower)) return true;
  return false;
}
