import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  TerminalResponseProfileDescriptorSchema,
  XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR,
  XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT,
  XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT_SOURCE,
} from '../packages/contracts/dist/index.js';
import {
  PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS,
  buildTerminalResponseProfileDescriptor,
} from '../packages/ui/dist/terminal/terminal-response-profile.js';

const requireFromUi = createRequire(
  new URL('../packages/ui/package.json', import.meta.url),
);

export function resolvedUiPackageVersion(packageName) {
  const manifest = requireFromUi(`${packageName}/package.json`);
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error(`missing resolved version for ${packageName}`);
  }
  return manifest.version;
}

/**
 * Lightweight release gate for response-affecting production-wrapper source.
 * Browser behavior remains covered by Playwright; this check makes exact
 * installed dependency/options/addon drift fail every non-browser verify run.
 */
export function assertTerminalResponseProfileSourceConformance(options = {}) {
  const runtimeInputs =
    options.runtimeInputs ?? PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS;
  const resolvePackageVersion =
    options.resolvePackageVersion ?? resolvedUiPackageVersion;
  const descriptor = TerminalResponseProfileDescriptorSchema.parse(
    buildTerminalResponseProfileDescriptor({
      runtimeInputs,
      schemaVersion: XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR.schemaVersion,
      responseClasses: XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR.responseClasses,
      resolvePackageVersion,
    }),
  );

  assert.deepEqual(
    descriptor,
    XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR,
    'production Terminal xterm/options/addons drifted from the negotiated response profile',
  );
  const fingerprintSource = JSON.stringify(descriptor);
  assert.equal(
    fingerprintSource,
    XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT_SOURCE,
    'production Terminal descriptor source drifted from the negotiated response profile',
  );
  assert.equal(
    createHash('sha256').update(fingerprintSource).digest('hex'),
    XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT,
    'production Terminal response-profile fingerprint is stale',
  );
  return descriptor;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const descriptor = assertTerminalResponseProfileSourceConformance();
  process.stdout.write(
    `terminal response profile source conformance: ${descriptor.xtermVersion} / ok\n`,
  );
}
