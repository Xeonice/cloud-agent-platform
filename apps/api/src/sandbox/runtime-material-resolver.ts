import type { AuthMaterial } from '../agent-runtime/agent-runtime.port';
import type { CodexAuthSource } from './codex-auth-source.port';
import type { ClaudeAuthSource } from './claude-auth-source.port';
import { assertSafeProviderUrl } from '../settings/assert-safe-provider-url';

export const RUNTIME_MATERIAL_RESOLVER_REGISTRY = Symbol(
  'RuntimeMaterialResolverRegistry',
);

export interface RuntimeMaterialResolverContext {
  readonly taskId: string;
}

export interface RuntimeMaterialResolver {
  readonly runtimeId: string;
  resolve(ctx: RuntimeMaterialResolverContext): Promise<AuthMaterial | null>;
}

export class RuntimeMaterialResolverRegistry {
  private readonly resolvers = new Map<string, RuntimeMaterialResolver>();

  constructor(resolvers: readonly RuntimeMaterialResolver[] = []) {
    for (const resolver of resolvers) {
      this.register(resolver);
    }
  }

  register(resolver: RuntimeMaterialResolver): void {
    if (this.resolvers.has(resolver.runtimeId)) {
      throw new Error(
        `Runtime material resolver for "${resolver.runtimeId}" is already registered`,
      );
    }
    this.resolvers.set(resolver.runtimeId, resolver);
  }

  async resolve(
    runtime: { readonly id: string },
    ctx: RuntimeMaterialResolverContext,
  ): Promise<AuthMaterial | null> {
    return (await this.resolvers.get(runtime.id)?.resolve(ctx)) ?? null;
  }

  ids(): readonly string[] {
    return [...this.resolvers.keys()];
  }
}

export interface DefaultRuntimeMaterialResolverRegistryOptions {
  readonly codexAuthSource: CodexAuthSource;
  readonly claudeAuthSource?: ClaudeAuthSource;
  readonly warn?: (message: string) => void;
}

export function createDefaultRuntimeMaterialResolverRegistry(
  options: DefaultRuntimeMaterialResolverRegistryOptions,
): RuntimeMaterialResolverRegistry {
  return new RuntimeMaterialResolverRegistry([
    createCodexRuntimeMaterialResolver(options.codexAuthSource, options.warn),
    createClaudeRuntimeMaterialResolver(options.claudeAuthSource),
  ]);
}

export function createCodexRuntimeMaterialResolver(
  codexAuthSource: CodexAuthSource,
  warn: ((message: string) => void) | undefined,
): RuntimeMaterialResolver {
  return {
    runtimeId: 'codex',
    async resolve(ctx): Promise<AuthMaterial | null> {
      const material = await codexAuthSource.getCodexAuth(ctx.taskId);
      if (!material) return null;
      if (material.kind === 'compatible') {
        try {
          await assertSafeProviderUrl(material.baseUrl);
        } catch (err) {
          warn?.(
            `compatible provider Base URL for task ${ctx.taskId} failed host-safety validation (${
              err instanceof Error ? err.message : String(err)
            }); skipping provider injection (codex will be unauthenticated)`,
          );
          return null;
        }
        return {
          codexCompatible: {
            baseUrl: material.baseUrl,
            apiKey: material.apiKey,
            model: material.model,
          },
        };
      }
      return { authJson: material.authJson };
    },
  };
}

export function createClaudeRuntimeMaterialResolver(
  claudeAuthSource: ClaudeAuthSource | undefined,
): RuntimeMaterialResolver {
  return {
    runtimeId: 'claude-code',
    async resolve(): Promise<AuthMaterial | null> {
      const material = await claudeAuthSource?.getClaudeAuth();
      return material ? { oauthToken: material.oauthToken } : null;
    },
  };
}
