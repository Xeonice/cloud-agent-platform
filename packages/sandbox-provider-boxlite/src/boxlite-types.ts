import type {
  SandboxConnection,
  SandboxPreflightResult,
  SandboxResolvedEnvironmentMetadata,
} from '@cap/sandbox-core';
import type { BoxLiteSandbox } from './boxlite-client.js';

export interface BoxLiteProvisionedRun {
  readonly taskId: string;
  readonly sandbox: BoxLiteSandbox;
  readonly connection: SandboxConnection;
  readonly preflight?: SandboxPreflightResult;
  readonly environment?: SandboxResolvedEnvironmentMetadata | null;
}
