import { randomUUID } from 'node:crypto';
import { TextEncoder } from 'node:util';

import {
  SandboxProviderConfigurationError,
  SandboxSecretFileOperationError,
} from './errors.js';

export const SANDBOX_REDACTED_VALUE = '[REDACTED]' as const;
export const SANDBOX_SECRET_FILE_MODE = 0o600 as const;

const REDACTED_SECRET_BRAND: unique symbol = Symbol('RedactedSecret');
const EXACT_HOST_GIT_CREDENTIAL_BRAND: unique symbol = Symbol(
  'ExactHostGitCredential',
);
const SANDBOX_SECRET_FILE_HANDLE_BRAND: unique symbol = Symbol(
  'SandboxSecretFileHandle',
);

const redactedSecretValues = new WeakMap<RedactedSecret, string>();
const exactHostCredentials = new WeakSet<ExactHostGitCredential>();
const secretFilePaths = new WeakMap<SandboxSecretFileHandle, string>();

/**
 * Opaque, serialization-safe secret wrapper.
 *
 * The raw value has no public getter. It can only be consumed by the
 * provider-private secret writer in this module, and even there it is revealed
 * only for the duration of a callback.
 */
export interface RedactedSecret {
  readonly kind: 'redacted-secret';
  readonly [REDACTED_SECRET_BRAND]: true;
  toString(): typeof SANDBOX_REDACTED_VALUE;
  toJSON(): typeof SANDBOX_REDACTED_VALUE;
}

class RedactedSecretValue implements RedactedSecret {
  readonly kind = 'redacted-secret' as const;
  declare readonly [REDACTED_SECRET_BRAND]: true;

  toString(): typeof SANDBOX_REDACTED_VALUE {
    return SANDBOX_REDACTED_VALUE;
  }

  toJSON(): typeof SANDBOX_REDACTED_VALUE {
    return SANDBOX_REDACTED_VALUE;
  }
}

/** Create a redacted wrapper without exposing a corresponding reveal API. */
export function createRedactedSecret(value: string): RedactedSecret {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SandboxProviderConfigurationError(
      'Sandbox secret value must be a non-empty string',
    );
  }
  if (containsUnsafeControl(value)) {
    throw new SandboxProviderConfigurationError(
      'Sandbox secret value must not contain control characters',
    );
  }
  const secret = new RedactedSecretValue();
  redactedSecretValues.set(secret, value);
  return Object.freeze(secret);
}

async function withRedactedSecret(
  secret: RedactedSecret,
  consume: (value: string) => void | Promise<void>,
): Promise<void> {
  const value = redactedSecretValues.get(secret);
  if (value === undefined) {
    throw new SandboxProviderConfigurationError(
      'Sandbox secret must originate from the redacted secret factory',
    );
  }
  await consume(value);
}

export type SandboxGitHttpScheme = 'http' | 'https';

/**
 * Provider-neutral credential scope for one normalized HTTP(S) Git host.
 * The header remains opaque and cannot be recovered from this descriptor.
 */
export interface ExactHostGitCredential {
  readonly kind: 'exact-host-git-credential';
  readonly scheme: SandboxGitHttpScheme;
  /** Lower-case URL hostname without a non-default port suffix. */
  readonly host: string;
  /** Effective port, including the scheme default when the URL omits it. */
  readonly port: number;
  /** Normalized scheme/host/port origin. Default ports are omitted. */
  readonly origin: string;
  /** Exact Git URL subsection prefix. Always ends in `/`. */
  readonly urlPrefix: string;
  readonly authorizationHeader: RedactedSecret;
  readonly [EXACT_HOST_GIT_CREDENTIAL_BRAND]: true;
  toString(): string;
  toJSON(): Readonly<Record<string, unknown>>;
}

interface NormalizedExactHost {
  readonly scheme: SandboxGitHttpScheme;
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly urlPrefix: string;
}

class ExactHostGitCredentialValue implements ExactHostGitCredential {
  readonly kind = 'exact-host-git-credential' as const;
  declare readonly [EXACT_HOST_GIT_CREDENTIAL_BRAND]: true;

  constructor(
    readonly scheme: SandboxGitHttpScheme,
    readonly host: string,
    readonly port: number,
    readonly origin: string,
    readonly urlPrefix: string,
    readonly authorizationHeader: RedactedSecret,
  ) {}

  toString(): string {
    return `[ExactHostGitCredential ${this.urlPrefix} ${SANDBOX_REDACTED_VALUE}]`;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      kind: this.kind,
      scheme: this.scheme,
      host: this.host,
      port: this.port,
      origin: this.origin,
      urlPrefix: this.urlPrefix,
      authorizationHeader: SANDBOX_REDACTED_VALUE,
    };
  }
}

/**
 * Build the sole token-bearing descriptor used by the canonical workspace
 * path. The repository URL is clean; credential userinfo/query/fragment input
 * is rejected before the header enters the opaque wrapper.
 */
export function createExactHostGitCredential(
  repositoryUrl: string,
  authorizationHeader: string,
): ExactHostGitCredential {
  if (
    typeof authorizationHeader !== 'string' ||
    authorizationHeader.length === 0 ||
    authorizationHeader.length > 8_192 ||
    authorizationHeader !== authorizationHeader.trim()
  ) {
    throw new SandboxProviderConfigurationError(
      'Git authorization header must be non-empty, bounded, and have no surrounding whitespace',
    );
  }
  if (containsUnsafeControl(authorizationHeader)) {
    throw new SandboxProviderConfigurationError(
      'Git authorization header must not contain control characters',
    );
  }

  const normalized = normalizeExactHost(repositoryUrl);
  const credential = new ExactHostGitCredentialValue(
    normalized.scheme,
    normalized.host,
    normalized.port,
    normalized.origin,
    normalized.urlPrefix,
    createRedactedSecret(authorizationHeader),
  );
  exactHostCredentials.add(credential);
  return Object.freeze(credential);
}

export function isExactHostGitCredential(
  value: unknown,
): value is ExactHostGitCredential {
  return (
    typeof value === 'object' &&
    value !== null &&
    exactHostCredentials.has(value as ExactHostGitCredential)
  );
}

/** Prevent a descriptor prepared for one forge host being reused for another. */
export function exactHostGitCredentialMatchesRepository(
  credential: ExactHostGitCredential,
  repositoryUrl: string,
): boolean {
  return (
    isExactHostGitCredential(credential) &&
    credential.origin === normalizeExactHost(repositoryUrl).origin
  );
}

/**
 * Input accepted only by a provider-private file/archive transport.
 * Its content getter is intentionally not enumerable or serializable.
 */
export interface SandboxProviderPrivateSecretFileWriteRequest {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: typeof SANDBOX_SECRET_FILE_MODE;
  /** Non-secret settlement signal; it is never serialized into transport metadata. */
  readonly signal?: AbortSignal;
  readonly command?: never;
  readonly argv?: never;
  readonly env?: never;
  readonly stdin?: never;
  readonly authHeader?: never;
  readonly credential?: never;
  readonly secret?: never;
}

export interface SandboxProviderPrivateSecretFileDeleteRequest {
  readonly path: string;
  readonly command?: never;
  readonly argv?: never;
  readonly env?: never;
  readonly stdin?: never;
  readonly authHeader?: never;
  readonly credential?: never;
  readonly secret?: never;
}

/** Provider adapter boundary implemented with file input or archive transfer. */
export interface SandboxProviderPrivateSecretFileTransport {
  writeFile(
    request: SandboxProviderPrivateSecretFileWriteRequest,
  ): Promise<void>;
  /** Resolves only after the provider has confirmed the target is absent. */
  deleteFile(
    request: SandboxProviderPrivateSecretFileDeleteRequest,
  ): Promise<void>;
}

export interface SandboxSecretFileWriteRequest {
  readonly kind: 'git-http-credential';
  readonly credential: ExactHostGitCredential;
  /** Operation-wide cancellation/deadline signal owned by the staged engine. */
  readonly signal?: AbortSignal;
  /** The port owns location, mode, and content; callers cannot override them. */
  readonly path?: never;
  readonly mode?: never;
  readonly content?: never;
  readonly command?: never;
  readonly argv?: never;
  readonly env?: never;
  readonly stdin?: never;
  readonly authHeader?: never;
  readonly secret?: never;
}

export interface SandboxSecretFileHandle {
  readonly kind: 'sandbox-secret-file';
  /** Safe for a workspace command to reference, but redacted from serialization. */
  readonly path: string;
  readonly mode: typeof SANDBOX_SECRET_FILE_MODE;
  readonly [SANDBOX_SECRET_FILE_HANDLE_BRAND]: true;
  toString(): string;
  toJSON(): Readonly<Record<string, unknown>>;
}

class SandboxSecretFileHandleValue implements SandboxSecretFileHandle {
  readonly kind = 'sandbox-secret-file' as const;
  readonly mode = SANDBOX_SECRET_FILE_MODE;
  declare readonly [SANDBOX_SECRET_FILE_HANDLE_BRAND]: true;

  get path(): string {
    const path = secretFilePaths.get(this);
    if (path === undefined) {
      throw new SandboxProviderConfigurationError(
        'Sandbox secret file handle is invalid',
      );
    }
    return path;
  }

  toString(): string {
    return `[SandboxSecretFile ${SANDBOX_REDACTED_VALUE}]`;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      kind: this.kind,
      mode: this.mode,
      path: SANDBOX_REDACTED_VALUE,
    };
  }
}

export interface SandboxSecretFilePort {
  writeSecretFile(
    request: SandboxSecretFileWriteRequest,
  ): Promise<SandboxSecretFileHandle>;
  /**
   * Idempotent for a handle already deleted through the same port. Resolution
   * means the provider has confirmed the target file no longer exists, not
   * merely that an asynchronous delete was accepted.
   */
  deleteSecretFile(handle: SandboxSecretFileHandle): Promise<void>;
}

export interface CreateSandboxSecretFilePortOptions {
  /** Absolute guest directory configured by the provider adapter. */
  readonly directory: string;
  readonly transport: SandboxProviderPrivateSecretFileTransport;
  /** Injectable only for deterministic tests; output is strictly validated. */
  readonly createId?: () => string;
}

/**
 * Compose the canonical redacted port over a provider-private non-command
 * transport. No secret-bearing command, argv, env, stdin, or metadata object is
 * ever constructed.
 */
export function createSandboxSecretFilePort(
  options: CreateSandboxSecretFilePortOptions,
): SandboxSecretFilePort {
  const directory = normalizeSecretDirectory(options.directory);
  const createId = options.createId ?? randomUUID;
  const owned = new WeakSet<SandboxSecretFileHandle>();
  const deleted = new WeakSet<SandboxSecretFileHandle>();
  const activePaths = new Set<string>();

  return Object.freeze({
    async writeSecretFile(
      request: SandboxSecretFileWriteRequest,
    ): Promise<SandboxSecretFileHandle> {
      if (
        request.kind !== 'git-http-credential' ||
        !isExactHostGitCredential(request.credential)
      ) {
        throw new SandboxProviderConfigurationError(
          'Sandbox secret writer requires an exact-host Git credential',
        );
      }

      const id = createId();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
        throw new SandboxProviderConfigurationError(
          'Sandbox secret file id contains unsupported characters',
        );
      }
      const path = `${directory}/cap-git-credential-${id}.config`;
      if (activePaths.has(path)) {
        throw new SandboxProviderConfigurationError(
          'Sandbox secret file path collision',
        );
      }
      activePaths.add(path);

      try {
        await withRedactedSecret(
          request.credential.authorizationHeader,
          async (authorizationHeader) => {
            const content = new TextEncoder().encode(
              renderExactHostGitConfig(request.credential, authorizationHeader),
            );
            try {
              await options.transport.writeFile(
                privateWriteRequest(path, content, request.signal),
              );
            } finally {
              content.fill(0);
            }
          },
        );
      } catch {
        try {
          await options.transport.deleteFile(privateDeleteRequest(path));
        } catch {
          // Best-effort cleanup follows a failed write; the outward error stays
          // intentionally stable and secret-free.
        }
        activePaths.delete(path);
        throw new SandboxSecretFileOperationError('write');
      }

      const handle = new SandboxSecretFileHandleValue();
      secretFilePaths.set(handle, path);
      owned.add(handle);
      return Object.freeze(handle);
    },

    async deleteSecretFile(handle: SandboxSecretFileHandle): Promise<void> {
      if (!owned.has(handle)) {
        throw new SandboxProviderConfigurationError(
          'Sandbox secret file handle belongs to a different port',
        );
      }
      if (deleted.has(handle)) return;
      const path = secretFilePaths.get(handle);
      if (path === undefined) {
        throw new SandboxProviderConfigurationError(
          'Sandbox secret file handle is invalid',
        );
      }
      try {
        await options.transport.deleteFile(privateDeleteRequest(path));
      } catch {
        throw new SandboxSecretFileOperationError('delete');
      }
      deleted.add(handle);
      activePaths.delete(path);
    },
  });
}

class ProviderPrivateWriteRequestValue
  implements SandboxProviderPrivateSecretFileWriteRequest
{
  readonly #filePath: string;
  readonly #bytes: Uint8Array;
  readonly #signal: AbortSignal | undefined;

  constructor(
    filePath: string,
    bytes: Uint8Array,
    signal: AbortSignal | undefined,
  ) {
    this.#filePath = filePath;
    this.#bytes = bytes;
    this.#signal = signal;
  }

  get path(): string {
    return this.#filePath;
  }

  get content(): Uint8Array {
    return this.#bytes;
  }

  get mode(): typeof SANDBOX_SECRET_FILE_MODE {
    return SANDBOX_SECRET_FILE_MODE;
  }

  get signal(): AbortSignal | undefined {
    return this.#signal;
  }

  toString(): string {
    return `[SandboxProviderPrivateSecretFileWriteRequest ${SANDBOX_REDACTED_VALUE}]`;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      path: SANDBOX_REDACTED_VALUE,
      content: SANDBOX_REDACTED_VALUE,
      mode: this.mode,
    };
  }
}

class ProviderPrivateDeleteRequestValue
  implements SandboxProviderPrivateSecretFileDeleteRequest
{
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  get path(): string {
    return this.#filePath;
  }

  toString(): string {
    return `[SandboxProviderPrivateSecretFileDeleteRequest ${SANDBOX_REDACTED_VALUE}]`;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { path: SANDBOX_REDACTED_VALUE };
  }
}

function privateWriteRequest(
  path: string,
  content: Uint8Array,
  signal: AbortSignal | undefined,
): SandboxProviderPrivateSecretFileWriteRequest {
  return Object.freeze(
    new ProviderPrivateWriteRequestValue(path, content, signal),
  );
}

function privateDeleteRequest(
  path: string,
): SandboxProviderPrivateSecretFileDeleteRequest {
  return Object.freeze(new ProviderPrivateDeleteRequestValue(path));
}

function renderExactHostGitConfig(
  credential: ExactHostGitCredential,
  authorizationHeader: string,
): string {
  return (
    '[credential]\n' +
    '\thelper =\n' +
    '\tinteractive = never\n' +
    '[http]\n' +
    '\tfollowRedirects = false\n' +
    `[http ${quoteGitConfigValue(credential.urlPrefix)}]\n` +
    `\textraHeader = ${quoteGitConfigValue(authorizationHeader)}\n`
  );
}

function quoteGitConfigValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizeExactHost(repositoryUrl: string): NormalizedExactHost {
  if (
    typeof repositoryUrl !== 'string' ||
    repositoryUrl.length === 0 ||
    repositoryUrl !== repositoryUrl.trim() ||
    containsUnsafeControl(repositoryUrl)
  ) {
    throw new SandboxProviderConfigurationError(
      'Git repository URL must be non-empty without whitespace or control characters',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    throw new SandboxProviderConfigurationError(
      'Git repository URL must be a valid HTTP(S) URL',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SandboxProviderConfigurationError(
      'Git repository URL must use HTTP or HTTPS',
    );
  }
  if (parsed.hostname.length === 0) {
    throw new SandboxProviderConfigurationError(
      'Git repository URL must include a host',
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new SandboxProviderConfigurationError(
      'Git repository URL must not contain userinfo',
    );
  }
  if (
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    /[?#]/.test(repositoryUrl)
  ) {
    throw new SandboxProviderConfigurationError(
      'Git repository URL must not contain a query or fragment',
    );
  }
  if (parsed.pathname === '/' || parsed.pathname.length === 0) {
    throw new SandboxProviderConfigurationError(
      'Git repository URL must include a repository path',
    );
  }

  const scheme = parsed.protocol.slice(0, -1) as SandboxGitHttpScheme;
  const port = parsed.port.length > 0
    ? Number(parsed.port)
    : scheme === 'https'
      ? 443
      : 80;
  return Object.freeze({
    scheme,
    host: parsed.hostname.toLowerCase(),
    port,
    origin: parsed.origin,
    urlPrefix: `${parsed.origin}/`,
  });
}

function normalizeSecretDirectory(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    !value.startsWith('/') ||
    containsUnsafeControl(value)
  ) {
    throw new SandboxProviderConfigurationError(
      'Sandbox secret directory must be an absolute path without control characters',
    );
  }
  return value === '/' ? '' : value.replace(/\/+$/, '');
}

function containsUnsafeControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
