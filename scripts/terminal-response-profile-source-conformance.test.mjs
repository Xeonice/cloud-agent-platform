import assert from 'node:assert/strict';
import test from 'node:test';
import {
  XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR,
} from '../packages/contracts/dist/index.js';
import {
  PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS,
} from '../packages/ui/dist/terminal/terminal-response-profile.js';
import {
  assertTerminalResponseProfileSourceConformance,
} from './terminal-response-profile-source-conformance.mjs';

const expectedVersions = new Map([
  ['@xterm/xterm', XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR.xtermVersion],
  ...XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR.responseAffectingAddons.map(
    (addon) => [addon.name, addon.version],
  ),
]);

function expectedVersion(packageName) {
  const version = expectedVersions.get(packageName);
  if (!version) throw new Error(`unexpected package ${packageName}`);
  return version;
}

function runtimeInputs(overrides = {}) {
  return {
    ...PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS,
    windowOptions: {
      ...PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS.windowOptions,
    },
    responseAffectingAddons:
      PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS.responseAffectingAddons.map(
        (addon) => ({ ...addon }),
      ),
    ...overrides,
  };
}

test('canonical production wrapper source composes the negotiated descriptor', () => {
  assert.deepEqual(
    assertTerminalResponseProfileSourceConformance({
      resolvePackageVersion: expectedVersion,
    }),
    XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR,
  );
});

const mutations = [
  {
    name: 'installed xterm version',
    options: {
      resolvePackageVersion: (packageName) =>
        packageName === '@xterm/xterm' ? '5.5.1' : expectedVersion(packageName),
    },
  },
  {
    name: 'termName',
    options: { runtimeInputs: runtimeInputs({ termName: 'screen' }) },
  },
  {
    name: 'disableStdin',
    options: { runtimeInputs: runtimeInputs({ disableStdin: true }) },
  },
  {
    name: 'windowOptions',
    options: {
      runtimeInputs: runtimeInputs({
        windowOptions: {
          ...PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS.windowOptions,
          getWinSizePixels: true,
        },
      }),
    },
  },
  {
    name: 'response-affecting addon membership',
    options: {
      runtimeInputs: runtimeInputs({ responseAffectingAddons: [] }),
    },
  },
  {
    name: 'response-affecting addon configuration',
    options: {
      runtimeInputs: runtimeInputs({
        responseAffectingAddons: [
          {
            ...PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS
              .responseAffectingAddons[0],
            configuration: 'activeVersion=10',
          },
        ],
      }),
    },
  },
  {
    name: 'installed response-affecting addon version',
    options: {
      resolvePackageVersion: (packageName) =>
        packageName === '@xterm/addon-unicode11'
          ? '0.8.1'
          : expectedVersion(packageName),
    },
  },
];

for (const mutation of mutations) {
  test(`source gate rejects mutation: ${mutation.name}`, () => {
    assert.throws(() =>
      assertTerminalResponseProfileSourceConformance({
        resolvePackageVersion: expectedVersion,
        ...mutation.options,
      }),
    );
  });
}
