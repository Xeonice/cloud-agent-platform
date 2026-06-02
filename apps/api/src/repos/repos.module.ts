import { Module } from '@nestjs/common';
import { ReposController } from './repos.controller';
import { ReposService } from './repos.service';

/**
 * Feature module bundling the repos REST controller and its service. Relies on
 * the global `PrismaModule` for DB access.
 */
@Module({
  controllers: [ReposController],
  providers: [ReposService],
  exports: [ReposService],
})
export class ReposModule {}
