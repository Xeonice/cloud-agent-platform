import { Module } from '@nestjs/common';
import { ReposController } from './repos.controller';
import { ReposService } from './repos.service';
import { GithubImportController } from './github-import.controller';
import { GithubImportService } from './github-import.service';
import { GithubReposClient } from './github-repos.client';
import { LocalRepoImportService } from './local-import.service';
import { RepoCopyController } from './repo-copy.controller';
import { RepoCopyService } from './repo-copy.service';
import { ForgeModule } from '../forge/forge.module';
import { RepoStoreModule } from '../repo-store/repo-store.module';

/**
 * Feature module bundling the repos REST controllers and their services. Relies
 * on the global `PrismaModule` for DB access.
 *
 * The GitHub-import surface (be-github-import, 4.1–4.5) is co-located here rather
 * than in a separately-registered module so `app.module.ts` is untouched (the
 * metrics track owns app.module edits this run): the {@link GithubImportController}
 * mounts under `/repos/github/*` and the global `AuthGuard` session-gates it.
 *
 * add-repo-content-store: this module is where the repo-store is REACHED from.
 * {@link RepoStoreModule} is imported here (it registers itself nowhere else, by
 * design) so every import path — URL, forge picker, GitHub picker, local path —
 * acquires its bare-mirror content copy through {@link RepoCopyService}, and the
 * console-internal copy routes in {@link RepoCopyController} join the same
 * `/repos` prefix without touching `app.module.ts`.
 */
@Module({
  imports: [ForgeModule, RepoStoreModule],
  controllers: [ReposController, GithubImportController, RepoCopyController],
  providers: [
    ReposService,
    GithubImportService,
    GithubReposClient,
    RepoCopyService,
    LocalRepoImportService,
  ],
  exports: [ReposService, GithubImportService, RepoCopyService],
})
export class ReposModule {}
