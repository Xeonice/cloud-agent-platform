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

console.log('ok - SandboxModule exposes only the neutral sandbox host harness');
