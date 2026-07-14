import { z } from 'zod';
import {
  RuntimeExecutionEnvironmentSnapshotSchema,
  RuntimeModelCatalogQuerySchema,
  RuntimeModelCatalogSchema,
  RuntimeModelErrorSchema,
  TaskModelSelectorSchema,
  type RuntimeModelCatalog,
  type RuntimeModelCatalogQuery,
  type RuntimeModelError,
} from '@cap/contracts';
import {
  environmentSelectionFromCatalogQuery,
  type RuntimeModelCredentialResolver,
  type RuntimeModelEnvironmentResolver,
  type RuntimeModelPolicyResolver,
  RuntimeModelAdapterRegistry,
} from './runtime-model-catalog.port';
import {
  RuntimeModelCatalogCache,
  RuntimeModelCatalogCacheCapacityError,
} from './runtime-model-catalog-cache';
import {
  OwnerFairProbeScheduler,
  RuntimeModelProbeAbortedError,
  RuntimeModelProbeCapacityError,
} from './owner-fair-probe-scheduler';
import type {
  EffectiveRuntimeModelPolicy,
  ReadyRuntimeModelCredential,
  ResolvedRuntimeModelCatalog,
  RuntimeModelAdapterDescriptor,
  RuntimeModelAdapterResult,
  RuntimeModelDomainResult,
} from './runtime-model-catalog.types';
import {
  compareCodePoints,
  sha256Revision,
  stableJson,
} from './runtime-model-catalog.util';
import { RuntimeModelEnvironmentResolutionError } from './runtime-model-errors';

export interface RuntimeModelCatalogServiceOptions {
  readonly environmentResolver: RuntimeModelEnvironmentResolver;
  readonly credentialResolver: RuntimeModelCredentialResolver;
  readonly policyResolver: RuntimeModelPolicyResolver;
  readonly adapters: RuntimeModelAdapterRegistry;
  readonly cache: RuntimeModelCatalogCache<ResolvedRuntimeModelCatalog>;
  readonly scheduler: OwnerFairProbeScheduler;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

const RawAdapterResultSchema = z
  .object({
    defaultModel: z.string().nullable(),
    models: z
      .array(
        z
          .object({
            id: z.string(),
            displayName: z.string(),
            isDefault: z.boolean(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

/** Transport-neutral, owner-scoped runtime model catalog orchestration. */
export class RuntimeModelCatalogService {
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: RuntimeModelCatalogServiceOptions) {
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async query(
    ownerUserId: string,
    query: RuntimeModelCatalogQuery,
    signal?: AbortSignal,
  ): Promise<RuntimeModelDomainResult<RuntimeModelCatalog>> {
    const resolved = await this.resolveCatalog(ownerUserId, query, signal);
    return resolved.ok
      ? {
          ok: true,
          value: RuntimeModelCatalogSchema.parse(resolved.value.catalog),
        }
      : resolved;
  }

  async resolveCatalog(
    ownerUserId: string,
    query: RuntimeModelCatalogQuery,
    signal?: AbortSignal,
  ): Promise<RuntimeModelDomainResult<ResolvedRuntimeModelCatalog>> {
    const parsedQuery = RuntimeModelCatalogQuerySchema.parse(query);
    if (!ownerUserId.trim()) throw new Error('missing owner');
    try {
      const environment = await this.options.environmentResolver.resolve({
        ownerUserId,
        runtime: parsedQuery.runtime,
        selection: environmentSelectionFromCatalogQuery(parsedQuery),
      });
      const snapshot = RuntimeExecutionEnvironmentSnapshotSchema.parse(
        environment.snapshot,
      );
      const credentialResolution =
        await this.options.credentialResolver.resolve(
          ownerUserId,
          parsedQuery.runtime,
        );
      if (credentialResolution.status !== 'ready') {
        return unavailable(parsedQuery);
      }
      const credential = credentialResolution.credential;
      if (
        credential.ownerUserId !== ownerUserId ||
        credential.runtime !== parsedQuery.runtime
      ) {
        return unavailable(parsedQuery);
      }

      const policy = await this.options.policyResolver.resolve({
        ownerUserId,
        runtime: parsedQuery.runtime,
      });
      const adapter = this.options.adapters.resolve(
        parsedQuery.runtime,
        credential.mode,
      );
      if (!adapter) return unavailable(parsedQuery);

      const cacheKey = buildCacheKey({
        ownerUserId,
        credential,
        policy,
        adapter,
        snapshot,
      });
      const result = await this.options.cache.getOrLoad(
        cacheKey,
        ownerUserId,
        async () => {
          const raw = await this.discover({
            ownerUserId,
            credential,
            snapshot,
            policy,
            adapter,
            signal,
          });
          assertNoCredentialLeak(raw, credential);
          const catalog = normalizeCatalog({
            raw,
            adapter,
            credential,
            policy,
            runtime: parsedQuery.runtime,
            effectiveEnvironment: environment.effectiveEnvironment,
            cliVersion: snapshot.cliVersion,
          });
          return {
            catalog,
            executionEnvironmentSnapshot: snapshot,
          };
        },
      );

      return {
        ok: true,
        value: {
          catalog: RuntimeModelCatalogSchema.parse(result.catalog),
          executionEnvironmentSnapshot:
            RuntimeExecutionEnvironmentSnapshotSchema.parse(
              result.executionEnvironmentSnapshot,
            ),
        },
      };
    } catch (error) {
      if (error instanceof RuntimeModelEnvironmentResolutionError) throw error;
      const safeQuery = RuntimeModelCatalogQuerySchema.safeParse(query);
      const contextQuery = safeQuery.success
        ? safeQuery.data
        : ({ runtime: 'codex' } satisfies RuntimeModelCatalogQuery);
      if (error instanceof RuntimeModelProbeCapacityError) {
        return unavailable(contextQuery, {
          scope: error.scope,
          retryAfterMs: error.retryAfterMs,
        });
      }
      if (
        error instanceof RuntimeModelCatalogCacheCapacityError ||
        error instanceof RuntimeModelProbeAbortedError
      ) {
        return unavailable(contextQuery);
      }
      return unavailable(contextQuery);
    }
  }

  private async discover(input: {
    readonly ownerUserId: string;
    readonly credential: ReadyRuntimeModelCredential;
    readonly snapshot: ResolvedRuntimeModelCatalog['executionEnvironmentSnapshot'];
    readonly policy: EffectiveRuntimeModelPolicy;
    readonly adapter: RuntimeModelAdapterDescriptor;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeModelAdapterResult> {
    const controller = new AbortController();
    const deadlineAt = this.now() + this.requestTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const abort = () => controller.abort();
    if (input.signal?.aborted) controller.abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const discover = () =>
        input.adapter.discover({
          ownerUserId: input.ownerUserId,
          credential: input.credential,
          environment: input.snapshot,
          policy: input.policy,
          signal: controller.signal,
          deadlineAt,
        });
      return input.adapter.capacityClass === 'taskless-probe'
        ? await this.options.scheduler.run(
            input.ownerUserId,
            discover,
            controller.signal,
          )
        : await discover();
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
    }
  }
}

function assertNoCredentialLeak(
  raw: RuntimeModelAdapterResult,
  credential: ReadyRuntimeModelCredential,
): void {
  const sensitive = credentialSensitiveFragments(credential);
  if (sensitive.length === 0) return;
  const projected = [
    raw.defaultModel,
    ...raw.models.flatMap((item) => [item.id, item.displayName]),
  ].filter((value): value is string => typeof value === 'string');
  if (
    projected.some((value) =>
      sensitive.some((fragment) => value.includes(fragment)),
    )
  ) {
    throw new Error('adapter result contains private credential material');
  }
}

function credentialSensitiveFragments(
  credential: ReadyRuntimeModelCredential,
): readonly string[] {
  const values: string[] = [];
  if (credential.mode === 'official') {
    values.push(credential.authJson);
    try {
      collectSensitiveStringLeaves(JSON.parse(credential.authJson), values);
    } catch {
      // Credential readiness already validated JSON. Ignore defensive parse drift.
    }
  } else if (credential.mode === 'compatible') {
    values.push(credential.apiKey, credential.baseUrl);
  } else {
    values.push(credential.oauthToken);
  }
  return [...new Set(values.map((value) => value.trim()))].filter(
    (value) => value.length >= 4,
  );
}

function collectSensitiveStringLeaves(
  value: unknown,
  out: string[],
  sensitiveContext = false,
): void {
  if (typeof value === 'string') {
    if (sensitiveContext) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSensitiveStringLeaves(item, out, sensitiveContext);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectSensitiveStringLeaves(
        child,
        out,
        sensitiveContext ||
          /token|secret|api[_-]?key|authorization|account[_-]?id/i.test(key),
      );
    }
  }
}

function normalizeCatalog(args: {
  readonly raw: RuntimeModelAdapterResult;
  readonly adapter: RuntimeModelAdapterDescriptor;
  readonly credential: ReadyRuntimeModelCredential;
  readonly policy: EffectiveRuntimeModelPolicy;
  readonly runtime: RuntimeModelCatalog['runtime'];
  readonly effectiveEnvironment: RuntimeModelCatalog['effectiveEnvironment'];
  readonly cliVersion: string;
}): RuntimeModelCatalog {
  const raw = RawAdapterResultSchema.parse(args.raw);
  const seen = new Set<string>();
  const adapterDefaults: string[] = [];
  const normalized = raw.models.map((item) => {
    const parsedId = TaskModelSelectorSchema.parse(item.id);
    if (parsedId !== item.id || seen.has(parsedId)) {
      throw new Error('invalid adapter model selector');
    }
    seen.add(parsedId);
    const displayName = item.displayName.trim();
    if (
      !displayName ||
      displayName.length > 256 ||
      hasControlCharacter(displayName)
    ) {
      throw new Error('invalid adapter model display name');
    }
    if (item.isDefault) adapterDefaults.push(parsedId);
    return { id: parsedId, displayName };
  });
  if (adapterDefaults.length > 1) {
    throw new Error('adapter returned multiple default models');
  }

  const rawDefault =
    raw.defaultModel === null
      ? null
      : TaskModelSelectorSchema.parse(raw.defaultModel);
  if (rawDefault !== null && rawDefault !== raw.defaultModel) {
    throw new Error('invalid adapter default selector');
  }
  if (
    rawDefault !== null &&
    adapterDefaults.length === 1 &&
    adapterDefaults[0] !== rawDefault
  ) {
    throw new Error('adapter default metadata is inconsistent');
  }
  const credentialDefault = args.credential.effectiveDefaultModel;
  const effectiveDefault = credentialDefault ?? rawDefault ?? adapterDefaults[0] ?? null;
  if (effectiveDefault !== null && !seen.has(effectiveDefault)) {
    throw new Error('adapter default model is not in the catalog');
  }

  const allow = args.policy.allow ? new Set(args.policy.allow) : null;
  const deny = new Set(args.policy.deny);
  const models = normalized
    .filter((item) => (!allow || allow.has(item.id)) && !deny.has(item.id))
    .sort((left, right) => compareCodePoints(left.id, right.id))
    .map((item) => ({
      ...item,
      isDefault: item.id === effectiveDefault,
      availabilityEvidence: args.adapter.availabilityEvidence,
    }));
  const defaultModel = models.some((item) => item.id === effectiveDefault)
    ? effectiveDefault
    : null;
  const revisionInput = {
    runtime: args.runtime,
    effectiveEnvironment: args.effectiveEnvironment,
    cliVersion: args.cliVersion,
    source: args.adapter.source,
    completeness: args.adapter.completeness,
    defaultModel,
    models,
  };
  return RuntimeModelCatalogSchema.parse({
    ...revisionInput,
    revision: sha256Revision(revisionInput),
  });
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function buildCacheKey(args: {
  readonly ownerUserId: string;
  readonly credential: ReadyRuntimeModelCredential;
  readonly policy: EffectiveRuntimeModelPolicy;
  readonly adapter: RuntimeModelAdapterDescriptor;
  readonly snapshot: ResolvedRuntimeModelCatalog['executionEnvironmentSnapshot'];
}): string {
  const snapshot = args.snapshot;
  return stableJson({
    ownerUserId: args.ownerUserId,
    runtime: args.credential.runtime,
    credentialMode: args.credential.mode,
    credentialRevision: args.credential.revision,
    policyRevision: args.policy.revision,
    adapterRevision: args.adapter.adapterRevision,
    environment: {
      kind: snapshot.kind,
      managedEnvironmentId: snapshot.managedEnvironmentId,
      validationId: snapshot.validationId,
      validationContractVersion: snapshot.validationContractVersion,
      provider: snapshot.provider,
      providerFamily: snapshot.providerFamily,
      source: snapshot.source,
      immutableIdentity: snapshot.immutableIdentity,
      fingerprint: snapshot.fingerprint,
      sandboxMetadataChecksum: snapshot.sandboxMetadataChecksum,
      cliVersion: snapshot.cliVersion,
      cliArtifactChecksum: snapshot.cliArtifactChecksum,
    },
  });
}

function unavailable(
  query: RuntimeModelCatalogQuery,
  capacity?: { readonly scope: 'owner' | 'global'; readonly retryAfterMs: number },
): RuntimeModelDomainResult<never> {
  const context = {
    runtime: query.runtime,
    ...(Object.prototype.hasOwnProperty.call(query, 'sandboxEnvironmentId')
      ? { sandboxEnvironmentId: query.sandboxEnvironmentId }
      : {}),
  };
  const error: RuntimeModelError = RuntimeModelErrorSchema.parse({
    code: 'runtime_model_catalog_unavailable',
    message: 'Runtime model catalog is temporarily unavailable.',
    retryable: true,
    context,
    ...(capacity ? { capacity } : {}),
  });
  return { ok: false, error };
}
