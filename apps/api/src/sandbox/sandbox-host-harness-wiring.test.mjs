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

// The two provisioning paths no longer share a file: the durable one is still
// in the guardrails orchestrator, the inline one lives in `inline-admission`.
// The count stays 2 on purpose — one per path — so dropping the wiring from
// either path still fails here, exactly as it did when both were in one file.
const provisioningPathSources = [
  join(apiRoot, 'src', 'guardrails', 'guardrails.service.ts'),
  join(apiRoot, 'src', 'inline-admission', 'inline-admission.pipeline.ts'),
].map((path) => readFileSync(path, 'utf8'));

const countAcrossProvisioningPaths = (pattern) =>
  provisioningPathSources.reduce(
    (total, source) => total + (source.match(pattern) ?? []).length,
    0,
  );

// Asserted per file rather than as a total: the guardrails source also names
// `resolveWorkspaceSource` once more in the port adapter that hands the method
// to the inline pipeline, and that wiring line is not a provisioning path. The
// exact-count check below still pins the number of provision contexts at 2.
for (const [index, source] of provisioningPathSources.entries()) {
  assert.match(
    source,
    /resolveWorkspaceSource\(\s*taskId/,
    `provisioning path ${index === 0 ? 'durable' : 'inline'} must resolve a workspace source`,
  );
}
assert.equal(
  countAcrossProvisioningPaths(
    /workspaceSource === undefined \? \{\} : \{ workspaceSource \}/g,
  ),
  2,
  'both provision contexts must carry the resolved workspace source to the provider',
);

console.log('ok - SandboxModule exposes only the neutral sandbox host harness');
console.log('ok - repo-copy injection seam is wired end to end');
