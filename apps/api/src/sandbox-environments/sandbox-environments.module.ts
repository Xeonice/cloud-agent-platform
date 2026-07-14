import { Module } from '@nestjs/common';
import { SandboxEnvironmentsController } from './sandbox-environments.controller';
import { SandboxEnvironmentsService } from './sandbox-environments.service';
import {
  DefaultSandboxEnvironmentValidationRunner,
  SANDBOX_ENVIRONMENT_VALIDATION_RUNNER,
} from './sandbox-environments.validator';

@Module({
  controllers: [SandboxEnvironmentsController],
  providers: [
    SandboxEnvironmentsService,
    {
      provide: SANDBOX_ENVIRONMENT_VALIDATION_RUNNER,
      useClass: DefaultSandboxEnvironmentValidationRunner,
    },
  ],
  exports: [
    SandboxEnvironmentsService,
    SANDBOX_ENVIRONMENT_VALIDATION_RUNNER,
  ],
})
export class SandboxEnvironmentsModule {}
