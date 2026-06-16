import { Module } from '@nestjs/common';
import { HealthController, VersionController } from './health.controller';

/**
 * Liveness module exposing the unauthenticated `/health` endpoint plus its
 * sibling unauthenticated `/version` build-metadata endpoint
 * (versioned-release-pipeline, design D1). Both controllers are exempt from the
 * global operator-auth guard so probes and the version surface need no operator
 * principal.
 */
@Module({
  controllers: [HealthController, VersionController],
})
export class HealthModule {}
