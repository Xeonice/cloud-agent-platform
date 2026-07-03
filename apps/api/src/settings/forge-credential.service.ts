import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  ConnectForgeCredentialRequest,
  ForgeConnection,
  ForgeCredentialApiAccess,
  ForgeCredential,
  ForgeCredentialState,
  ForgeKind,
  RegisterForgeConnectionRequest,
  SessionUser,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import {
  ForgeHttpError,
  type AvailableRepo,
  type ForgeTarget,
} from '../forge/forge.port';
import { maskApiKeySuffix } from './settings-crypto';
import {
  assertEncryptionKeyValidIfConfigured,
  decryptStored,
  encryptToStored,
} from './secret-storage';

/** Well-known public git host per forge (the default host when none is supplied). */
const PUBLIC_HOST: Record<ForgeKind, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  gitee: 'gitee.com',
};

/** API base for the public SaaS host of each forge. */
const PUBLIC_API_BASE: Record<ForgeKind, string> = {
  github: 'https://api.github.com',
  gitlab: 'https://gitlab.com/api/v4',
  gitee: 'https://gitee.com/api/v5',
};

/** Self-hosted API base suffix per forge kind. */
const API_SUFFIX: Record<ForgeKind, string> = {
  github: '/api/v3',
  gitlab: '/api/v4',
  gitee: '/api/v5',
};

/** Timeout for the connect-time token validation probe. */
const VALIDATE_TIMEOUT_MS = 10_000;

type StoredForgeCredential = {
  token: string;
  apiAccess: ForgeCredentialApiAccess;
};

function legacyHostFilters(host: string): Array<
  { host: string } | { host: { startsWith: string } }
> {
  return [
    { host },
    { host: `https://${host}` },
    { host: `http://${host}` },
    { host: { startsWith: `https://${host}/` } },
    { host: { startsWith: `http://${host}/` } },
  ];
}

/**
 * Normalize user-facing host input into the canonical persisted forge host.
 *
 * Operators often paste `https://git.example.com/` from a browser address bar.
 * Persisting that verbatim breaks `(kind, host)` lookup against repo clone URLs,
 * which naturally resolve to just `git.example.com`.
 */
export function normalizeForgeHostInput(input: string | null | undefined, fallback: string): string {
  const raw = (input?.trim() || fallback).trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(candidate).host.toLowerCase();
  } catch {
    return raw
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
  }
}

function normalizeApiAccess(value: unknown): ForgeCredentialApiAccess {
  return value === 'unverified' ? 'unverified' : 'verified';
}

/**
 * Stores + manages forge (code-hosting) push-back credentials (add-forge-credentials).
 *
 * The write-scoped PAT for a forge the operator OWNS. On connect the token is
 * validated by a plain native fetch to the operator's connected forge (a trusted
 * call — NOT `assertSafeProviderUrl`-gated) and, on success, stored AES-256-GCM
 * encrypted (born-encrypted; `encryptToStored` fails closed without a server key,
 * exactly like the codex compatible key). Reads are secret-free; the plaintext is
 * recovered only at point of use via {@link getForgeCredential} (consumed by the
 * change-C push-back). `ForgeConnection` is the self-hosted host→apiBase registry.
 */
@Injectable()
export class ForgeCredentialService implements OnModuleInit {
  private readonly logger = new Logger(ForgeCredentialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: DefaultForgeRegistry,
  ) {}

  /**
   * Import picker (add-multi-forge-task-delivery): list the repos the operator's
   * connected forge credential can access. A trusted native-fetch to the
   * operator's own forge (NOT SSRF-gated). Throws when the forge is not connected.
   */
  async listAvailableRepos(
    operator: SessionUser,
    kind: ForgeKind,
    host?: string,
  ): Promise<AvailableRepo[]> {
    const userId = await this.requireUserId(operator);
    const resolvedHost = normalizeForgeHostInput(host, PUBLIC_HOST[kind]);
    const credential = await this.getStoredForgeCredential(userId, kind, resolvedHost);
    if (!credential) {
      throw new BadRequestException({
        error: 'forge_not_connected',
        message: `No connected ${kind} credential to list repositories from.`,
      });
    }
    const apiBaseUrl = await this.resolveApiBase(kind, resolvedHost);
    // Listing uses only kind + apiBaseUrl + token; repoId/cloneUrl are inert here.
    const target: ForgeTarget = {
      kind,
      apiBaseUrl,
      token: credential.token,
      cloneUrl: '',
      repoId:
        kind === 'gitlab'
          ? { style: 'project', idOrPath: '' }
          : { style: 'owner-repo', owner: '', repo: '' },
    };
    try {
      return await this.registry.forKind(kind).listRepos(target);
    } catch (err) {
      throw new BadRequestException({
        error: 'forge_list_unavailable',
        reason: this.listUnavailableReason(credential.apiAccess, err),
        message:
          'The connected forge credential was saved for git operations, but ' +
          'the repository list API is unavailable. Import by repository URL instead.',
      });
    }
  }

  /**
   * Boot fail-fast: a CONFIGURED-but-invalid encryption key must not start
   * silently (it would break every encrypted write). A missing key is allowed
   * (encryption disabled — github tokens stay plaintext as before).
   */
  onModuleInit(): void {
    assertEncryptionKeyValidIfConfigured();
  }

  /** Connect a forge by validating + storing an encrypted PAT. */
  async connect(
    operator: SessionUser,
    request: ConnectForgeCredentialRequest,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ForgeCredential> {
    const userId = await this.requireUserId(operator);
    const kind = request.kind;
    const host = normalizeForgeHostInput(request.host, PUBLIC_HOST[kind]);
    const apiBase = await this.resolveApiBase(kind, host);

    const valid = await this.validateToken(kind, apiBase, request.token);
    const apiAccess: ForgeCredentialApiAccess = valid ? 'verified' : 'unverified';

    const tokenCiphertext = encryptToStored(request.token, env);
    const tokenLast4 = maskApiKeySuffix(request.token);

    await this.prisma.forgeCredential.upsert({
      where: { userId_kind_host: { userId, kind, host } },
      create: {
        userId,
        kind,
        host,
        tokenCiphertext,
        tokenLast4,
        state: 'connected',
        apiAccess,
      },
      update: { tokenCiphertext, tokenLast4, state: 'connected', apiAccess },
    });

    return { kind, host, state: 'connected', apiAccess, last4: tokenLast4 };
  }

  /** Secret-free list of the operator's connected forges. */
  async list(operator: SessionUser): Promise<ForgeCredential[]> {
    const userId = await this.requireUserId(operator);
    const rows = await this.prisma.forgeCredential.findMany({
      where: { userId },
      orderBy: [{ kind: 'asc' }, { host: 'asc' }],
    });
    return rows.map((r) => ({
      kind: r.kind as ForgeKind,
      host: r.host,
      state: r.state as ForgeCredentialState,
      apiAccess: normalizeApiAccess((r as { apiAccess?: unknown }).apiAccess),
      last4: r.tokenLast4,
    }));
  }

  /** Disconnect (delete) a forge credential. */
  async disconnect(
    operator: SessionUser,
    kind: ForgeKind,
    host: string,
  ): Promise<void> {
    const userId = await this.requireUserId(operator);
    const normalizedHost = normalizeForgeHostInput(host, PUBLIC_HOST[kind]);
    await this.prisma.forgeCredential.deleteMany({
      where: { userId, kind, OR: legacyHostFilters(normalizedHost) },
    });
  }

  /**
   * Owner-scoped decryption primitive for change C: returns the plaintext PAT for
   * a given (userId, kind, host), or null when none is stored / decrypt fails.
   * Never logs or returns the token elsewhere.
   */
  async getForgeCredential(
    userId: string,
    kind: ForgeKind,
    host: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<string | null> {
    const row = await this.findForgeCredentialRow(userId, kind, host);
    return decryptStored(row?.tokenCiphertext, env);
  }

  /** Register (or update) a self-hosted forge connection. */
  async registerConnection(
    request: RegisterForgeConnectionRequest,
  ): Promise<ForgeConnection> {
    const kind = request.kind;
    const host = normalizeForgeHostInput(request.host, request.host);
    const apiBaseUrl = request.apiBaseUrl?.trim() || `https://${host}${API_SUFFIX[kind]}`;
    const row = await this.prisma.forgeConnection.upsert({
      where: { host },
      create: { host, kind, apiBaseUrl },
      update: { kind, apiBaseUrl },
    });
    return {
      host: row.host,
      kind: row.kind as ForgeKind,
      apiBaseUrl: row.apiBaseUrl,
      projectId: row.projectId,
    };
  }

  /** List registered self-hosted forge connections. */
  async listConnections(): Promise<ForgeConnection[]> {
    const rows = await this.prisma.forgeConnection.findMany({
      orderBy: { host: 'asc' },
    });
    return rows.map((r) => ({
      host: r.host,
      kind: r.kind as ForgeKind,
      apiBaseUrl: r.apiBaseUrl,
      projectId: r.projectId,
    }));
  }

  /** Resolve the forge API base for a host (public inference or the registry). */
  private async resolveApiBase(kind: ForgeKind, host: string): Promise<string> {
    const resolvedHost = normalizeForgeHostInput(host, PUBLIC_HOST[kind]);
    if (resolvedHost === PUBLIC_HOST[kind]) {
      return PUBLIC_API_BASE[kind];
    }
    const conn = await this.prisma.forgeConnection.findUnique({
      where: { host: resolvedHost },
    });
    if (conn?.apiBaseUrl) {
      return conn.apiBaseUrl;
    }
    return `https://${resolvedHost}${API_SUFFIX[kind]}`;
  }

  private async getStoredForgeCredential(
    userId: string,
    kind: ForgeKind,
    host: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<StoredForgeCredential | null> {
    const row = await this.findForgeCredentialRow(userId, kind, host);
    const token = decryptStored(row?.tokenCiphertext, env);
    if (!token) {
      return null;
    }
    return {
      token,
      apiAccess: normalizeApiAccess((row as { apiAccess?: unknown } | null)?.apiAccess),
    };
  }

  private async findForgeCredentialRow(
    userId: string,
    kind: ForgeKind,
    host: string,
  ) {
    const resolvedHost = normalizeForgeHostInput(host, PUBLIC_HOST[kind]);
    const exact = await this.prisma.forgeCredential.findUnique({
      where: { userId_kind_host: { userId, kind, host: resolvedHost } },
    });
    if (exact) {
      return exact;
    }
    return this.prisma.forgeCredential.findFirst({
      where: { userId, kind, OR: legacyHostFilters(resolvedHost) },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private listUnavailableReason(
    apiAccess: ForgeCredentialApiAccess,
    err: unknown,
  ): string {
    if (apiAccess === 'unverified') {
      return 'api_unverified';
    }
    if (err instanceof ForgeHttpError && (err.status === 401 || err.status === 403)) {
      return 'permission_denied';
    }
    return 'forge_unavailable';
  }

  /**
   * Validates a forge PAT with a cheap authenticated GET of the current user.
   * A plain native fetch to the operator's connected forge — NOT SSRF-gated. A
   * 2xx means the token is live; anything else (or a network error) is invalid.
   */
  private async validateToken(
    kind: ForgeKind,
    apiBase: string,
    token: string,
  ): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (kind === 'gitlab') {
      headers['PRIVATE-TOKEN'] = token;
    } else {
      headers.Authorization = `Bearer ${token}`;
      if (kind === 'github') {
        headers.Accept = 'application/vnd.github+json';
        headers['X-GitHub-Api-Version'] = '2022-11-28';
      }
    }
    try {
      const res = await fetch(`${apiBase}/user`, {
        headers,
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Resolves the operator's account row id — the single per-account scope key is
   * the account primary key `operator.id` (fix-local-account-settings-scope),
   * present for BOTH local and GitHub accounts. No GitHub identity is required and
   * no reverse lookup is performed (forge credential rows are already FK
   * `User.id`).
   *
   * `account_scope_required` is retained ONLY as the defensive "no authenticated
   * account at all" case (an identity-less machine/legacy principal).
   */
  private requireUserId(operator: SessionUser): string {
    const userId = operator?.id;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new BadRequestException({
        error: 'account_scope_required',
        message: 'Forge credentials are per-account and require an authenticated account.',
      });
    }
    return userId;
  }
}
