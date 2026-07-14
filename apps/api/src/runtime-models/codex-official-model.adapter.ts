import { Logger } from '@nestjs/common';
import type { RuntimeModelAdapterDescriptor } from './runtime-model-catalog.types';
import { sha256Revision } from './runtime-model-catalog.util';
import {
  runTasklessRuntimeModelProbe,
  type RuntimeModelTasklessProbeLifecycle,
} from './runtime-model-probe.port';
import { assertRuntimeModelAdapterSnapshot } from './runtime-model-adapter-snapshot';

/** Official Codex subscription adapter backed by exact-image App Server. */
export class CodexOfficialModelAdapter
  implements RuntimeModelAdapterDescriptor
{
  readonly runtime = 'codex' as const;
  readonly credentialMode = 'official' as const;
  readonly source = 'codex-app-server' as const;
  readonly completeness = 'complete' as const;
  readonly availabilityEvidence = 'account-discovered' as const;
  readonly capacityClass = 'taskless-probe' as const;
  readonly adapterRevision = sha256Revision({
    adapter: 'codex-official-app-server',
    protocolPin: '0.144.1',
    version: 1,
  });
  private readonly logger = new Logger(CodexOfficialModelAdapter.name);

  constructor(private readonly lifecycle: RuntimeModelTasklessProbeLifecycle) {}

  async discover(
    input: Parameters<RuntimeModelAdapterDescriptor['discover']>[0],
  ) {
    if (
      input.credential.mode !== 'official' ||
      input.credential.ownerUserId !== input.ownerUserId
    ) {
      throw new Error('Official Codex credential is unavailable.');
    }
    assertRuntimeModelAdapterSnapshot(input.environment, 'codex');
    return runTasklessRuntimeModelProbe({
      lifecycle: this.lifecycle,
      ownerUserId: input.ownerUserId,
      environment: input.environment,
      credential: input.credential,
      signal: input.signal,
      deadlineAt: input.deadlineAt,
      onCleanupError: (stage) =>
        this.logger.error(`Codex model probe ${stage} failed.`),
    });
  }
}
