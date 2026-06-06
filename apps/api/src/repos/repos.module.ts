import { Module } from '@nestjs/common';
import { ReposController } from './repos.controller';
import { ReposService } from './repos.service';
import { GithubImportController } from './github-import.controller';
import { GithubImportService } from './github-import.service';
import { GithubReposClient } from './github-repos.client';

/**
 * Feature module bundling the repos REST controllers and their services. Relies
 * on the global `PrismaModule` for DB access.
 *
 * The GitHub-import surface (be-github-import, 4.1–4.5) is co-located here rather
 * than in a separately-registered module so `app.module.ts` is untouched (the
 * metrics track owns app.module edits this run): the {@link GithubImportController}
 * mounts under `/repos/github/*` and the global `AuthGuard` session-gates it.
 */
@Module({
  controllers: [ReposController, GithubImportController],
  providers: [ReposService, GithubImportService, GithubReposClient],
  exports: [ReposService, GithubImportService],
})
export class ReposModule {}
