import { Module } from '@nestjs/common';
import { FORGE } from './forge.port';
import { GithubForge } from './github-forge';
import { GiteeForge } from './gitee-forge';
import { GitlabForge } from './gitlab-forge';
import { DefaultForgeRegistry } from './forge-registry';
import { ForgeTargetResolver } from './forge-target-resolver';
import {
  NodeRemoteRefsCommandRunner,
  RemoteRefsCommandRunner,
} from './remote-refs-command-runner';
import { GitRemoteRefsProbe, RemoteRefsProbePort } from './remote-refs-probe';
import { TaskBranchResolver } from './task-branch-resolver';
import {
  NodeRemoteRefsSecretStore,
  RemoteRefsSecretStore,
} from './remote-refs-secret-store';

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
    NodeRemoteRefsCommandRunner,
    {
      provide: RemoteRefsCommandRunner,
      useExisting: NodeRemoteRefsCommandRunner,
    },
    NodeRemoteRefsSecretStore,
    {
      provide: RemoteRefsSecretStore,
      useExisting: NodeRemoteRefsSecretStore,
    },
    GitRemoteRefsProbe,
    { provide: RemoteRefsProbePort, useExisting: GitRemoteRefsProbe },
    TaskBranchResolver,
    { provide: FORGE, useExisting: DefaultForgeRegistry },
  ],
  exports: [
    FORGE,
    DefaultForgeRegistry,
    ForgeTargetResolver,
    RemoteRefsProbePort,
    TaskBranchResolver,
    GithubForge,
    GiteeForge,
    GitlabForge,
  ],
})
export class ForgeModule {}
