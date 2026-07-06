import type {
  SandboxEnvironmentProviderFamily,
  SandboxRunOwnerStore,
  SandboxResolvedEnvironmentMetadata,
  SandboxTranscriptSourceBase,
} from '@cap/sandbox-core';

export interface SandboxHostLogger {
  debug?(message: string): void;
  log?(message: string): void;
  warn?(message: string): void;
}

export interface SandboxHostProvisionLookup<TCloneSpec> {
  getCloneSpec(taskId: string): Promise<TCloneSpec | null>;
  getTaskPrompt(taskId: string): Promise<string | null | undefined>;
  getTaskSkills?(taskId: string): Promise<readonly string[]>;
  getResolvedEnvironment?(
    taskId: string,
    providerFamily: SandboxEnvironmentProviderFamily,
    runtimeId?: string | null,
  ): Promise<SandboxResolvedEnvironmentMetadata | null | undefined>;
}

export interface SandboxHostRuntimePreflightProbe {
  readonly name: string;
  readonly command: string;
}

export interface SandboxHostSetupCommand {
  readonly command: string;
  readonly tolerateUnresolvedExit: boolean;
}

export type SandboxHostSetupPlan =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly commands: readonly SandboxHostSetupCommand[] };

export interface SandboxHostRuntime<TAuthMaterial> {
  readonly id: string;
  preflightProbes(): readonly SandboxHostRuntimePreflightProbe[];
  sandboxSetupCommands(
    ctx: {
      readonly taskId: string;
      readonly workspaceDir: string;
      readonly prompt: string | null;
    },
    material: TAuthMaterial | null,
  ): SandboxHostSetupPlan;
  preStopTrimCommands(): readonly string[];
  transcriptArtifact(ctx: {
    readonly taskId: string;
    readonly workspaceDir: string;
    readonly sessionId?: string;
  }): {
    readonly dir: string;
    readonly filenameGlob: RegExp;
  };
  readonly transcriptFormat: string;
  readonly readTranscriptSource: {
    readonly kind: string;
  };
}

export interface SandboxHostRuntimeRegistry<TRuntimeId, TAuthMaterial> {
  resolve(id?: TRuntimeId | null): SandboxHostRuntime<TAuthMaterial>;
  resolveForTask?(
    taskId: string,
  ): Promise<SandboxHostRuntime<TAuthMaterial>>;
}

export interface SandboxHostMaterialResolvers<TAuthMaterial> {
  resolve(
    runtime: { readonly id: string },
    ctx: { readonly taskId: string },
  ): Promise<TAuthMaterial | null>;
}

export interface SandboxHostCodexAuthSource {
  persistRefreshedAuth(taskId: string, authJson: string): Promise<void>;
}

export interface SandboxHostSkillInstaller {
  readonly id: string;
  readonly label: string;
  command(workspaceDir: string): readonly string[];
}

export interface SandboxHostSkillInstallers {
  resolveSkillInstaller(id: string): SandboxHostSkillInstaller | undefined;
}

export interface SandboxHostApprovalSink {
  recordApprovalEvent?(event: {
    readonly taskId: string;
    readonly kind: string;
    readonly payload?: unknown;
  }): Promise<void> | void;
}

export interface SandboxHostHarness<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
> {
  readonly ownerStore?: SandboxRunOwnerStore;
  readonly provisionLookup: SandboxHostProvisionLookup<TCloneSpec>;
  readonly runtimeRegistry: SandboxHostRuntimeRegistry<TRuntimeId, TAuthMaterial>;
  readonly materialResolvers: SandboxHostMaterialResolvers<TAuthMaterial>;
  readonly codexAuthSource?: SandboxHostCodexAuthSource;
  readonly skillInstallers?: SandboxHostSkillInstallers;
  readonly approvalSink?: SandboxHostApprovalSink;
  readonly sessionIdForTask?: (taskId: string) => string;
  readonly logger?: SandboxHostLogger;
  readonly transcriptSource?: {
    create(args: {
      readonly format: string;
      readonly jsonl: string;
    }): TTranscriptSource;
  };
}
