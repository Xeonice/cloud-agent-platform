import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..');
const moduleSource = readFileSync(
  join(apiRoot, 'src', 'sandbox', 'sandbox.module.ts'),
  'utf8',
);

assert.match(
  moduleSource,
  /import\s+\{\s*createConfiguredSandboxProvider\s*\}\s+from\s+['"]@cap\/sandbox['"]/,
  'SandboxModule must bind SANDBOX_PROVIDER through the @cap/sandbox host-harness factory',
);

assert.match(
  moduleSource,
  /createConfiguredSandboxProvider\s*</,
  'SandboxModule should call the neutral configured sandbox provider factory',
);

for (const requiredKey of [
  'ownerStore',
  'runtimeRegistry: runtimes',
  'materialResolvers',
  'provisionLookup: lookup',
  'codexAuthSource',
  'skillInstallers: { resolveSkillInstaller }',
  'sessionIdForTask',
]) {
  assert.match(
    moduleSource,
    new RegExp(requiredKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `SandboxModule passes host harness port: ${requiredKey}`,
  );
}

for (const forbidden of [
  'defineAioSandboxProvider',
  'defineAioSandboxProviderFromDocker',
  'defineBoxLiteSandboxProvider',
  'defineHttpCloudSandboxProvider',
  'readBoxLiteProviderConfig',
  'readConfiguredSandboxProviderFamily',
  'createBoxLiteRuntimePreflight',
  'AioSandboxContainerController',
  'Docker',
  'dockerode',
  'BOXLITE_',
  'AIO_SANDBOX_',
  'CAP_SANDBOX_PROVIDER',
]) {
  assert.doesNotMatch(
    moduleSource,
    new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `SandboxModule must not compose concrete providers or read provider env: ${forbidden}`,
  );
}

// add-repo-content-store Track 4 — the injection seam must stay REACHABLE.
// The previous attempt at this change died as "built but unreachable": the
// components existed and nothing wired them together. These assertions fail the
// build if the workspace-source resolver is dropped from the DI graph, if the
// repo-store module stops being imported where the seam consumes it, or if the
// Prisma lookup stops receiving the resolver.
assert.match(
  moduleSource,
  /imports:\s*\[[^\]]*RepoStoreModule/,
  'SandboxModule must import RepoStoreModule so the injection seam can read repo copies',
);
assert.match(
  moduleSource,
  /provide:\s*WorkspaceSourceResolver/,
  'SandboxModule must provide WorkspaceSourceResolver',
);
assert.match(
  moduleSource,
  /inject:\s*\[PrismaService,\s*RepoStoreService,\s*REPO_STORE_VOLUME_INSPECTOR\]/,
  'WorkspaceSourceResolver must receive prisma, the repo store, and the volume inspector',
);
assert.match(
  moduleSource,
  /provide:\s*REPO_STORE_VOLUME_INSPECTOR/,
  'SandboxModule must bind the repo-store volume inspector seam',
);

const lookupSource = readFileSync(
  join(apiRoot, 'src', 'sandbox', 'prisma-provision-lookup.ts'),
  'utf8',
);
assert.match(
  lookupSource,
  /workspaceSourceResolver\?:\s*WorkspaceSourceResolver/,
  'PrismaProvisionLookup must accept the workspace-source resolver',
);
assert.match(
  lookupSource,
  /this\.getTaskWorkspaceSource\s*=/,
  'PrismaProvisionLookup must expose getTaskWorkspaceSource when a resolver is injected',
);

const guardrailsSource = readFileSync(
  join(apiRoot, 'src', 'guardrails', 'guardrails.service.ts'),
  'utf8',
);
assert.equal(
  (guardrailsSource.match(/this\.resolveWorkspaceSource\(/g) ?? []).length,
  2,
  'both provisioning paths (durable + legacy) must resolve a workspace source',
);
assert.equal(
  (guardrailsSource.match(/workspaceSource === undefined \? \{\} : \{ workspaceSource \}/g) ?? [])
    .length,
  2,
  'both provision contexts must carry the resolved workspace source to the provider',
);

console.log('ok - SandboxModule exposes only the neutral sandbox host harness');
console.log('ok - repo-copy injection seam is wired end to end');
