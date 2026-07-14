import { createHmac, randomBytes } from 'node:crypto';
import { TaskModelSelectorSchema, type Runtime } from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { assertSafeProviderUrl } from '../settings/assert-safe-provider-url';
import { decryptStored } from '../settings/secret-storage';
import type { RuntimeModelCredentialResolver } from './runtime-model-catalog.port';
import type {
  RuntimeModelCredentialResolution,
  RuntimeModelCredentialUnreadyReason,
} from './runtime-model-catalog.types';

const PROCESS_REVISION_KEY = randomBytes(32);

export interface PrismaRuntimeModelCredentialResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly revisionKey?: Buffer;
}

/** Owner-scoped execution credential resolver used before a Task exists. */
export class PrismaRuntimeModelCredentialResolver
  implements RuntimeModelCredentialResolver
{
  private readonly env: NodeJS.ProcessEnv;
  private readonly revisionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    options: PrismaRuntimeModelCredentialResolverOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.revisionKey = options.revisionKey ?? PROCESS_REVISION_KEY;
  }

  async resolve(
    ownerUserId: string,
    runtime: Runtime,
  ): Promise<RuntimeModelCredentialResolution> {
    if (!ownerUserId.trim()) {
      return this.unready(ownerUserId, runtime, 'missing', undefined, 'owner');
    }
    return runtime === 'codex'
      ? this.resolveCodex(ownerUserId)
      : this.resolveClaude(ownerUserId);
  }

  private async resolveCodex(
    ownerUserId: string,
  ): Promise<RuntimeModelCredentialResolution> {
    let row;
    try {
      row = await this.prisma.codexCredential.findUnique({
        where: { userId: ownerUserId },
        select: {
          mode: true,
          state: true,
          baseUrl: true,
          apiKeyCiphertext: true,
          defaultModel: true,
          authJsonCiphertext: true,
        },
      });
    } catch {
      return this.unready(
        ownerUserId,
        'codex',
        'lookup-failed',
        undefined,
        'lookup',
      );
    }

    if (!row) return this.resolveDeploymentCodex(ownerUserId);
    const rowRevision = this.revision({ runtime: 'codex', ownerUserId, row });
    if (row.mode === 'official') {
      if (row.state !== 'connected' || !row.authJsonCiphertext) {
        return this.unready(
          ownerUserId,
          'codex',
          'incomplete',
          row.mode,
          rowRevision,
        );
      }
      const authJson = decryptStored(row.authJsonCiphertext, this.env);
      if (!authJson || !isCodexAuthJson(authJson)) {
        return this.unready(
          ownerUserId,
          'codex',
          'decrypt-failed',
          row.mode,
          rowRevision,
        );
      }
      return {
        status: 'ready',
        credential: {
          runtime: 'codex',
          mode: 'official',
          ownerUserId,
          scope: 'owner',
          revision: rowRevision,
          authJson,
          effectiveDefaultModel: null,
        },
      };
    }
    if (row.mode === 'compatible') {
      const defaultModel = TaskModelSelectorSchema.safeParse(row.defaultModel);
      if (
        row.state !== 'connected' ||
        !row.baseUrl ||
        !row.apiKeyCiphertext ||
        !defaultModel.success
      ) {
        return this.unready(
          ownerUserId,
          'codex',
          'incomplete',
          row.mode,
          rowRevision,
        );
      }
      const apiKey = decryptStored(row.apiKeyCiphertext, this.env);
      if (!apiKey) {
        return this.unready(
          ownerUserId,
          'codex',
          'decrypt-failed',
          row.mode,
          rowRevision,
        );
      }
      try {
        await assertSafeProviderUrl(row.baseUrl);
      } catch {
        return this.unready(
          ownerUserId,
          'codex',
          'incomplete',
          row.mode,
          rowRevision,
        );
      }
      return {
        status: 'ready',
        credential: {
          runtime: 'codex',
          mode: 'compatible',
          ownerUserId,
          scope: 'owner',
          revision: rowRevision,
          baseUrl: row.baseUrl,
          apiKey,
          effectiveDefaultModel: defaultModel.data,
        },
      };
    }
    return this.unready(
      ownerUserId,
      'codex',
      'unsupported-mode',
      row.mode,
      rowRevision,
    );
  }

  private async resolveClaude(
    ownerUserId: string,
  ): Promise<RuntimeModelCredentialResolution> {
    let row;
    try {
      row = await this.prisma.claudeCredential.findUnique({
        where: { userId: ownerUserId },
        select: {
          mode: true,
          state: true,
          setupTokenCiphertext: true,
          apiKeyCiphertext: true,
          defaultModel: true,
        },
      });
    } catch {
      return this.unready(
        ownerUserId,
        'claude-code',
        'lookup-failed',
        undefined,
        'lookup',
      );
    }

    if (!row) return this.resolveDeploymentClaude(ownerUserId);
    const rowRevision = this.revision({
      runtime: 'claude-code',
      ownerUserId,
      row,
    });
    if (row.mode === 'api_key') {
      return this.unready(
        ownerUserId,
        'claude-code',
        'unsupported-mode',
        row.mode,
        rowRevision,
      );
    }
    if (
      row.mode !== 'subscription' ||
      row.state !== 'connected' ||
      !row.setupTokenCiphertext
    ) {
      return this.unready(
        ownerUserId,
        'claude-code',
        'incomplete',
        row.mode,
        rowRevision,
      );
    }
    const oauthToken = decryptStored(row.setupTokenCiphertext, this.env);
    if (!oauthToken) {
      return this.unready(
        ownerUserId,
        'claude-code',
        'decrypt-failed',
        row.mode,
        rowRevision,
      );
    }
    return {
      status: 'ready',
      credential: {
        runtime: 'claude-code',
        mode: 'subscription',
        ownerUserId,
        scope: 'owner',
        revision: rowRevision,
        oauthToken,
        effectiveDefaultModel: null,
      },
    };
  }

  private resolveDeploymentCodex(
    ownerUserId: string,
  ): RuntimeModelCredentialResolution {
    const encoded = this.env.CODEX_CHATGPT_AUTH_JSON_B64?.trim();
    if (!encoded) {
      return this.unready(ownerUserId, 'codex', 'missing', undefined, 'env-missing');
    }
    let authJson: string;
    try {
      authJson = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return this.unready(
        ownerUserId,
        'codex',
        'incomplete',
        'official',
        this.revision(encoded),
      );
    }
    if (!isCodexAuthJson(authJson)) {
      return this.unready(
        ownerUserId,
        'codex',
        'incomplete',
        'official',
        this.revision(encoded),
      );
    }
    return {
      status: 'ready',
      credential: {
        runtime: 'codex',
        mode: 'official',
        ownerUserId,
        scope: 'deployment',
        revision: this.revision({ runtime: 'codex', encoded }),
        authJson,
        effectiveDefaultModel: null,
      },
    };
  }

  private resolveDeploymentClaude(
    ownerUserId: string,
  ): RuntimeModelCredentialResolution {
    const oauthToken = this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (!oauthToken) {
      return this.unready(
        ownerUserId,
        'claude-code',
        'missing',
        undefined,
        'env-missing',
      );
    }
    return {
      status: 'ready',
      credential: {
        runtime: 'claude-code',
        mode: 'subscription',
        ownerUserId,
        scope: 'deployment',
        revision: this.revision({ runtime: 'claude-code', oauthToken }),
        oauthToken,
        effectiveDefaultModel: null,
      },
    };
  }

  private unready(
    ownerUserId: string,
    runtime: Runtime,
    reason: RuntimeModelCredentialUnreadyReason,
    configuredMode: string | undefined,
    revisionInput: unknown,
  ): RuntimeModelCredentialResolution {
    return {
      status: 'unready',
      ownerUserId,
      runtime,
      reason,
      ...(configuredMode ? { configuredMode } : {}),
      revision: this.revision(revisionInput),
    };
  }

  private revision(value: unknown): string {
    return `hmac-sha256:${createHmac('sha256', this.revisionKey)
      .update(JSON.stringify(value))
      .digest('hex')}`;
  }
}

function isCodexAuthJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as {
      auth_mode?: unknown;
      tokens?: unknown;
      OPENAI_API_KEY?: unknown;
    };
    return (
      parsed.auth_mode !== undefined ||
      parsed.tokens !== undefined ||
      parsed.OPENAI_API_KEY !== undefined
    );
  } catch {
    return false;
  }
}
