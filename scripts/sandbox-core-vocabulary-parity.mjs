#!/usr/bin/env node
/**
 * sandbox-core ↔ contracts vocabulary parity gate.
 *
 * `packages/sandbox-core` declares ZERO runtime dependencies so a third party can
 * implement the sandbox port without inheriting ours. That is why its TYPES now
 * derive from `@cap-console/contracts` through erased `import type`, while its
 * runtime ARRAYS cannot: `validateEnum` consumes them as values, and a value
 * import would pull zod into a package whose whole point is having nothing.
 *
 * So ten vocabularies exist twice, on purpose (an eleventh pair, the
 * environment source-kind declaration vs its runtime-model derivation, lives
 * entirely inside contracts — see the PAIRS note). What was missing is any
 * mechanism keeping the two copies honest — until now they agreed because
 * whoever last edited one remembered the other. `provider-family.ts` records what that costs:
 * the family list "was previously restated independently in four places whose
 * contents disagreed", two of them differing even in member ORDER, which is the
 * signature of independent hand-maintenance.
 *
 * This gate is the mechanism. It compares MEMBER SETS, not order: every consumer
 * uses these arrays for membership (`validateEnum` does `includes`), so order
 * carries no meaning, and asserting it would fail today on a difference that
 * means nothing — the families are `aio, cloud-http, boxlite, unknown` in
 * sandbox-core and `aio, boxlite, cloud-http, unknown` in the contract.
 *
 * Run: node scripts/sandbox-core-vocabulary-parity.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * Each pair: a runtime array in `sandbox-core` and the contract enum it mirrors.
 *
 * `extraInSandbox` / `extraInContract` name members one side may carry that the
 * other does not, as an EXPLICIT widening. An unlisted difference fails, in
 * either direction. Today every pair is exactly equal and both lists are empty;
 * the fields exist so a future divergence has to be written down rather than
 * absorbed.
 *
 * Two sandbox-core vocabularies are deliberately absent because the contract has
 * no counterpart to compare against: `SANDBOX_WORKSPACE_MATERIALIZATION_STAGES`
 * and `SANDBOX_PHYSICAL_CLEANUP_OUTCOMES` describe steps inside the sandbox that
 * no api response names. They are sandbox-core-only by design, not oversights.
 *
 * One pair (unlock-extension-axes D6) reconciles a vocabulary WITHIN contracts:
 * the environment source-kind declaration (`sandbox-environment.ts`, managed +
 * extension tiers — hence `arrays`, whose members are unioned) against the
 * runtime-model snapshot union DERIVED from it (`root` overrides the default
 * sandbox-core location; the schema side is a discriminated union whose member
 * `kind` literals are the vocabulary).
 */
export const PAIRS = [
  {
    file: 'src/provider.ts',
    array: 'SANDBOX_EXECUTION_MODES',
    schema: 'SandboxModeSchema',
  },
  {
    file: 'src/workspace-source.ts',
    array: 'WORKSPACE_SOURCE_KINDS',
    schema: 'TaskProvisioningDiagnosticWorkspaceSourceKindSchema',
  },
  {
    file: 'src/provisioning-diagnostics.ts',
    array: 'SANDBOX_PROVISIONING_DIAGNOSTIC_ADMISSION_MODES',
    schema: 'TaskProvisioningDiagnosticAdmissionModeSchema',
  },
  {
    file: 'src/provisioning-diagnostics.ts',
    array: 'SANDBOX_PROVISIONING_DIAGNOSTIC_PROVIDER_FAMILIES',
    schema: 'TaskProvisioningDiagnosticProviderFamilySchema',
  },
  {
    file: 'src/provisioning-diagnostics.ts',
    array: 'SANDBOX_PROVISIONING_DIAGNOSTIC_STAGES',
    schema: 'TaskProvisioningDiagnosticStageSchema',
  },
  {
    file: 'src/provisioning-diagnostics.ts',
    array: 'SANDBOX_PROVISIONING_DIAGNOSTIC_OPERATIONS',
    schema: 'TaskProvisioningDiagnosticOperationSchema',
  },
  {
    file: 'src/provisioning-diagnostics.ts',
    array: 'SANDBOX_PROVISIONING_DIAGNOSTIC_CHANNELS',
    schema: 'TaskProvisioningDiagnosticChannelSchema',
  },
  {
    file: 'src/provisioning-diagnostics.ts',
    array: 'SANDBOX_PROVISIONING_DIAGNOSTIC_OUTCOMES',
    schema: 'TaskProvisioningDiagnosticOutcomeSchema',
  },
  {
    file: 'src/provisioning-diagnostics.ts',
    array: 'SANDBOX_PROVISIONING_DIAGNOSTIC_CAUSES',
    schema: 'TaskProvisioningDiagnosticCauseSchema',
  },
  {
    file: 'src/provisioning-diagnostics.ts',
    array: 'SANDBOX_PROVISIONING_DIAGNOSTIC_COMMAND_KINDS',
    schema: 'TaskProvisioningDiagnosticCommandKindSchema',
  },
  {
    root: 'packages/contracts',
    file: 'src/sandbox-environment.ts',
    arrays: [
      'SANDBOX_ENVIRONMENT_MANAGED_SOURCE_KINDS',
      'SANDBOX_ENVIRONMENT_EXTENSION_SOURCE_KINDS',
    ],
    schema: 'RuntimeExecutionEnvironmentSourceSchema',
  },
];

/**
 * Members read out of source text, not out of a build, so a rename in
 * `sandbox-core` is caught by this gate rather than by a stale `dist`.
 */
export function readArrayMembers(source, name) {
  const declaration = new RegExp(
    `export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`,
    'u',
  );
  const match = declaration.exec(source);
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/gu)].map((m) => m[1]);
}

/**
 * The whole gate as a pure function.
 *
 * @param pairs           the vocabulary pairs to check
 * @param readSource      (relativePath) => file text, or null if absent
 * @param readSchema      (exportName) => member array, or null if not an enum
 * @returns problems, each a human-readable line naming both sides
 */
export function findVocabularyDisagreements({ pairs, readSource, readSchema }) {
  const problems = [];
  for (const pair of pairs) {
    const root = pair.root ?? 'packages/sandbox-core';
    const arrayNames = pair.arrays ?? [pair.array];
    const arrayLabel = arrayNames.join(' ∪ ');
    const source = readSource(pair.file, root);
    if (source == null) {
      problems.push(
        `${pair.file}: not readable — this gate names the files it protects, so a move must update PAIRS`,
      );
      continue;
    }
    let missingArray = false;
    const arrayMembers = [];
    for (const arrayName of arrayNames) {
      const members = readArrayMembers(source, arrayName);
      if (members == null) {
        problems.push(
          `${arrayName}: not found in ${root}/${pair.file} — a renamed or removed vocabulary must leave this list`,
        );
        missingArray = true;
        continue;
      }
      arrayMembers.push(...members);
    }
    if (missingArray) continue;
    const schemaMembers = readSchema(pair.schema);
    if (schemaMembers == null) {
      problems.push(
        `${pair.schema}: not an enum export of @cap-console/contracts`,
      );
      continue;
    }

    const sandbox = new Set(arrayMembers);
    const contract = new Set(schemaMembers);
    const extraInSandbox = pair.extraInSandbox ?? [];
    const extraInContract = pair.extraInContract ?? [];

    for (const member of sandbox) {
      if (!contract.has(member) && !extraInSandbox.includes(member)) {
        problems.push(
          `${arrayLabel}: has '${member}', ${pair.schema} does not`,
        );
      }
    }
    for (const member of contract) {
      if (!sandbox.has(member) && !extraInContract.includes(member)) {
        problems.push(
          `${pair.schema}: has '${member}', ${arrayLabel} does not`,
        );
      }
    }
    // A widening that is no longer there is also a disagreement: it means the
    // exception outlived what it excepted and is now silently permitting
    // whatever takes that name next.
    for (const member of extraInSandbox) {
      if (!sandbox.has(member)) {
        problems.push(
          `${arrayLabel}: '${member}' is declared an allowed widening but is not in the array`,
        );
      }
    }
    for (const member of extraInContract) {
      if (!contract.has(member)) {
        problems.push(
          `${pair.schema}: '${member}' is declared an allowed widening but is not in the enum`,
        );
      }
    }
  }
  return problems;
}

/**
 * Vocabulary members of a contracts dist export: a `z.enum`'s string options,
 * or — for the derived source-kind pair — a `z.discriminatedUnion` whose member
 * object schemas each carry their vocabulary member as the `kind` literal.
 */
export function schemaEnumMembers(schema) {
  const options = schema?.options;
  if (!Array.isArray(options)) return null;
  if (options.every((option) => typeof option === 'string')) return options;
  const kinds = options.map((option) => option?.shape?.kind?.value);
  if (kinds.length > 0 && kinds.every((kind) => typeof kind === 'string')) {
    return kinds;
  }
  return null;
}

async function main() {
  let contracts;
  try {
    contracts = await import(path.join(ROOT, 'packages/contracts/dist/index.js'));
  } catch {
    console.error(
      'sandbox-core-vocabulary-parity: build @cap-console/contracts first — this gate reads its enums as values.',
    );
    process.exitCode = 1;
    return;
  }

  const problems = findVocabularyDisagreements({
    pairs: PAIRS,
    readSource: (rel, root = 'packages/sandbox-core') => {
      try {
        return readFileSync(path.join(ROOT, root, rel), 'utf8');
      } catch {
        return null;
      }
    },
    readSchema: (name) => schemaEnumMembers(contracts[name]),
  });

  if (problems.length === 0) {
    console.log(
      `sandbox-core-vocabulary-parity: ${PAIRS.length} vocabularies, each declared twice by necessity and in agreement`,
    );
    return;
  }

  console.error(
    `sandbox-core-vocabulary-parity: ${problems.length} disagreement(s) between packages/sandbox-core and @cap-console/contracts:\n`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nThese vocabularies exist twice because sandbox-core declares no runtime',
  );
  console.error(
    'dependencies and so cannot import a value from contracts. Converge them, or',
  );
  console.error('state the difference as an explicit widening in PAIRS with a reason.');
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
