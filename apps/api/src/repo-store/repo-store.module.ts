import { Module } from '@nestjs/common';
import {
  NodeRepoStoreCommandRunner,
  NodeRepoStoreCredentialStore,
  RepoStoreCommandRunner,
  RepoStoreCredentialStore,
} from './repo-store-git';
import { RepoStoreService } from './repo-store.service';

/**
 * Repo-store feature module (add-repo-content-store): owns the bare-mirror
 * copies in the shared `repo-store` volume and the host-git machinery that
 * materializes them.
 *
 * Deliberately standalone and dependency-light (only the global `PrismaModule`)
 * so the import flows (Track 3) and the sandbox injection seam (Track 4) can
 * import it without dragging the repos/tasks modules into each other. It is NOT
 * registered in `app.module.ts` by this track — the import-flow track wires it
 * where it is consumed.
 */
@Module({
  providers: [
    NodeRepoStoreCommandRunner,
    { provide: RepoStoreCommandRunner, useExisting: NodeRepoStoreCommandRunner },
    NodeRepoStoreCredentialStore,
    { provide: RepoStoreCredentialStore, useExisting: NodeRepoStoreCredentialStore },
    RepoStoreService,
  ],
  exports: [RepoStoreService],
})
export class RepoStoreModule {}
