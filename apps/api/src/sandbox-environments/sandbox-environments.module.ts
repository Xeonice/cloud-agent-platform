import { Module } from '@nestjs/common';
import { SandboxEnvironmentsController } from './sandbox-environments.controller';
import { SandboxEnvironmentsService } from './sandbox-environments.service';

@Module({
  controllers: [SandboxEnvironmentsController],
  providers: [SandboxEnvironmentsService],
  exports: [SandboxEnvironmentsService],
})
export class SandboxEnvironmentsModule {}
