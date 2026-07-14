import type {
  SandboxCommandExecutor,
  SandboxPreflightResult,
  SandboxTranscriptSourceBase,
  TaskModelIntent,
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
  readonly modelIntent: TaskModelIntent;
  readonly executionMode: 'interactive-pty' | 'headless-exec';
  readonly sandbox: BoxLiteSandbox;
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
  readonly runtimeId?: string | null;
}

export type BoxLiteRuntimeSetup = (
  context: BoxLiteRuntimeSetupContext,
) => Promise<void> | void;

export interface BoxLiteTranscriptReadContext<TRuntimeId = string> {
  readonly taskId: string;
  readonly runtimeId?: TRuntimeId | null;
  readonly sandbox: BoxLiteSandbox;
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
}

export type BoxLiteTranscriptRead<
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> = (
  context: BoxLiteTranscriptReadContext<TRuntimeId>,
) => Promise<TTranscriptSource | null> | TTranscriptSource | null;

export type BoxLitePreStopCleanupContext = Omit<
  BoxLiteRuntimeSetupContext,
  'modelIntent' | 'executionMode'
>;

export type BoxLitePreStopCleanup = (
  context: BoxLitePreStopCleanupContext,
) => Promise<void> | void;

export interface BoxLiteRuntimePreflightOptions {
  readonly requiredTools: readonly string[];
  readonly workspacePath?: string;
  readonly commandTimeoutMs?: number;
  readonly cache?: Map<string, SandboxPreflightResult>;
  readonly now?: () => Date;
}
