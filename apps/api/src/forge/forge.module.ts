import { Module } from '@nestjs/common';
import { FORGE } from './forge.port';
import { GithubForge } from './github-forge';
import { GiteeForge } from './gitee-forge';
import { GitlabForge } from './gitlab-forge';
import { DefaultForgeRegistry } from './forge-registry';
import { ForgeTargetResolver } from './forge-target-resolver';

/**
 * The Forge feature module (add-multi-forge-task-delivery): binds the three forge
 * implementations + the {@link DefaultForgeRegistry} (detection + kind→impl) + the
 * {@link ForgeTargetResolver} (owner-scoped credential resolution), and exposes the
 * `FORGE` token. Relies on the global `PrismaModule` for the `ForgeConnection` +
 * `ForgeCredential` lookups — it has NO dependency on SettingsModule (it decrypts
 * via the shared pure helpers), so it can be imported by GuardrailsModule without a
 * module cycle.
 */
@Module({
  providers: [
    GithubForge,
    GiteeForge,
    GitlabForge,
    DefaultForgeRegistry,
    ForgeTargetResolver,
    { provide: FORGE, useExisting: DefaultForgeRegistry },
  ],
  exports: [
    FORGE,
    DefaultForgeRegistry,
    ForgeTargetResolver,
    GithubForge,
    GiteeForge,
    GitlabForge,
  ],
})
export class ForgeModule {}
