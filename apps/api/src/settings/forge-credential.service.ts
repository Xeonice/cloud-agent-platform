import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  ConnectForgeCredentialRequest,
  ForgeConnection,
  ForgeCredential,
  ForgeCredentialState,
  ForgeKind,
  RegisterForgeConnectionRequest,
  SessionUser,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import type { AvailableRepo, ForgeTarget } from '../forge/forge.port';
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
    const resolvedHost = (host?.trim() || PUBLIC_HOST[kind]).toLowerCase();
    const token = await this.getForgeCredential(userId, kind, resolvedHost);
    if (!token) {
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
      token,
      cloneUrl: '',
      repoId:
        kind === 'gitlab'
          ? { style: 'project', idOrPath: '' }
          : { style: 'owner-repo', owner: '', repo: '' },
    };
    return this.registry.forKind(kind).listRepos(target);
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
    const host = (request.host?.trim() || PUBLIC_HOST[kind]).toLowerCase();
    const apiBase = await this.resolveApiBase(kind, host);

    const valid = await this.validateToken(kind, apiBase, request.token);
    if (!valid) {
      throw new BadRequestException({
        error: 'forge_token_invalid',
        message:
          'The forge token could not be validated (revoked, insufficient ' +
          'scope, or the forge was unreachable). Nothing was stored.',
      });
    }

    const tokenCiphertext = encryptToStored(request.token, env);
    const tokenLast4 = maskApiKeySuffix(request.token);

    await this.prisma.forgeCredential.upsert({
      where: { userId_kind_host: { userId, kind, host } },
      create: { userId, kind, host, tokenCiphertext, tokenLast4, state: 'connected' },
      update: { tokenCiphertext, tokenLast4, state: 'connected' },
    });

    return { kind, host, state: 'connected', last4: tokenLast4 };
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
    await this.prisma.forgeCredential.deleteMany({
      where: { userId, kind, host: host.toLowerCase() },
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
    const row = await this.prisma.forgeCredential.findUnique({
      where: { userId_kind_host: { userId, kind, host: host.toLowerCase() } },
    });
    return decryptStored(row?.tokenCiphertext, env);
  }

  /** Register (or update) a self-hosted forge connection. */
  async registerConnection(
    request: RegisterForgeConnectionRequest,
  ): Promise<ForgeConnection> {
    const host = request.host.trim().toLowerCase();
    const kind = request.kind;
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
    if (host === PUBLIC_HOST[kind]) {
      return PUBLIC_API_BASE[kind];
    }
    const conn = await this.prisma.forgeConnection.findUnique({ where: { host } });
    if (conn?.apiBaseUrl) {
      return conn.apiBaseUrl;
    }
    return `https://${host}${API_SUFFIX[kind]}`;
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
