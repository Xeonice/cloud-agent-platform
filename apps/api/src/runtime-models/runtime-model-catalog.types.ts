import type {
  Runtime,
  RuntimeExecutionEnvironmentSnapshot,
  RuntimeModelAvailabilityEvidence,
  RuntimeModelCatalog,
  RuntimeModelCatalogCompleteness,
  RuntimeModelCatalogSource,
  RuntimeModelEffectiveEnvironment,
  RuntimeModelError,
} from '@cap/contracts';

export type RuntimeModelCredentialMode =
  | 'official'
  | 'compatible'
  | 'subscription';

interface ReadyCredentialBase {
  readonly ownerUserId: string;
  readonly scope: 'owner' | 'deployment';
  /** Opaque process-local cache revision. Never expose or log it. */
  readonly revision: string;
}

export interface ReadyOfficialCodexCredential extends ReadyCredentialBase {
  readonly runtime: 'codex';
  readonly mode: 'official';
  readonly authJson: string;
  readonly effectiveDefaultModel: null;
}

export interface ReadyCompatibleCodexCredential extends ReadyCredentialBase {
  readonly runtime: 'codex';
  readonly mode: 'compatible';
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly effectiveDefaultModel: string;
}

export interface ReadyClaudeSubscriptionCredential
  extends ReadyCredentialBase {
  readonly runtime: 'claude-code';
  readonly mode: 'subscription';
  readonly oauthToken: string;
  readonly effectiveDefaultModel: null;
}

export type ReadyRuntimeModelCredential =
  | ReadyOfficialCodexCredential
  | ReadyCompatibleCodexCredential
  | ReadyClaudeSubscriptionCredential;

export type RuntimeModelCredentialUnreadyReason =
  | 'missing'
  | 'unsupported-mode'
  | 'incomplete'
  | 'decrypt-failed'
  | 'lookup-failed';

export type RuntimeModelCredentialResolution =
  | {
      readonly status: 'ready';
      readonly credential: ReadyRuntimeModelCredential;
    }
  | {
      readonly status: 'unready';
      readonly ownerUserId: string;
      readonly runtime: Runtime;
      readonly configuredMode?: string;
      readonly reason: RuntimeModelCredentialUnreadyReason;
      readonly revision: string;
    };

export interface EffectiveRuntimeModelPolicy {
  readonly version: 1;
  /** null means allow every adapter-reported selector. */
  readonly allow: readonly string[] | null;
  readonly deny: readonly string[];
  readonly revision: string;
}

export interface ResolvedRuntimeModelEnvironment {
  readonly effectiveEnvironment: RuntimeModelEffectiveEnvironment;
  readonly snapshot: RuntimeExecutionEnvironmentSnapshot;
}

export interface RuntimeModelAdapterItem {
  readonly id: string;
  readonly displayName: string;
  readonly isDefault: boolean;
}

/**
 * Adapter-private discovery output. Descriptor-owned evidence fields are not
 * accepted here, so an adapter cannot accidentally overstate its guarantees.
 */
export interface RuntimeModelAdapterResult {
  readonly defaultModel: string | null;
  readonly models: readonly RuntimeModelAdapterItem[];
}

export interface RuntimeModelAdapterDescriptor {
  readonly runtime: Runtime;
  readonly credentialMode: RuntimeModelCredentialMode;
  readonly source: RuntimeModelCatalogSource;
  readonly completeness: RuntimeModelCatalogCompleteness;
  readonly availabilityEvidence: RuntimeModelAvailabilityEvidence;
  readonly capacityClass: 'taskless-probe' | 'none';
  readonly adapterRevision: string;
  discover(input: {
    readonly ownerUserId: string;
    readonly credential: ReadyRuntimeModelCredential;
    readonly environment: RuntimeExecutionEnvironmentSnapshot;
    readonly policy: EffectiveRuntimeModelPolicy;
    readonly signal?: AbortSignal;
    readonly deadlineAt: number;
  }): Promise<RuntimeModelAdapterResult>;
}

export interface ResolvedRuntimeModelCatalog {
  readonly catalog: RuntimeModelCatalog;
  readonly executionEnvironmentSnapshot: RuntimeExecutionEnvironmentSnapshot;
}

export type RuntimeModelDomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RuntimeModelError };

export type RuntimeModelPreflightSuccess =
  | {
      readonly intent: 'runtime-default';
      readonly model: null;
      readonly executionEnvironmentSnapshot: null;
    }
  | {
      readonly intent: 'explicit';
      readonly model: string;
      readonly executionEnvironmentSnapshot: RuntimeExecutionEnvironmentSnapshot;
    };
