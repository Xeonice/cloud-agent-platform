import type {
  SandboxCommandExecutor,
  SandboxPreflightResult,
} from '@cap/sandbox-core';
import type { BoxLiteSandbox } from './boxlite-client.js';

export interface BoxLiteProviderIdentity {
  getProviderId(): string;
}

export interface BoxLiteRuntimePreflightContext {
  readonly taskId: string;
  readonly provider: BoxLiteProviderIdentity;
  readonly sandbox: BoxLiteSandbox;
  readonly executor: SandboxCommandExecutor;
  readonly runtimeId?: string | null;
}

export type BoxLiteRuntimePreflight = (
  context: BoxLiteRuntimePreflightContext,
) => Promise<SandboxPreflightResult> | SandboxPreflightResult;

export interface BoxLiteRuntimeSetupContext {
  readonly taskId: string;
  readonly sandbox: BoxLiteSandbox;
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
}

export type BoxLiteRuntimeSetup = (
  context: BoxLiteRuntimeSetupContext,
) => Promise<void> | void;

export interface BoxLiteRuntimePreflightOptions {
  readonly requiredTools: readonly string[];
  readonly workspacePath?: string;
  readonly commandTimeoutMs?: number;
  readonly cache?: Map<string, SandboxPreflightResult>;
  readonly now?: () => Date;
}
