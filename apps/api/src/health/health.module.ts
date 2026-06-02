import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Liveness module exposing the unauthenticated `/health` endpoint. */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
