/**
 * Conformance participation, derived from what a provider DECLARES.
 *
 * `sandbox-provider-port` requires that "a provider SHALL NOT advertise a
 * capability that does not pass its conformance scenario". Nothing enforced it:
 * which scenario families ran was chosen by whoever wrote each provider's test
 * file, with no link to that provider's declared capabilities. Today's picks
 * happen to be defensible — AIO and cloud-http skip command-output conformance
 * and neither declares `command.exec` — but nothing checked that they were, so
 * the arrangement was one edit away from a provider advertising a capability
 * nothing exercised, with no one the wiser.
 *
 * This module makes the requirement a mechanism: a provider hands over its
 * declared capabilities plus the suites it can build, and gets back exactly the
 * scenarios it owes. Skipping a family it owes is not a smaller test run, it is
 * an error.
 */
import type { SandboxProviderCapability } from '@cap/sandbox-core';

import type { SandboxProviderConformanceScenario } from './conformance.js';

/** The scenario families this package exports. */
export type SandboxConformanceFamily =
  | 'provider'
  | 'behavior'
  | 'diagnostic'
  | 'command-output';

/**
 * How a capability is covered.
 *
 * - `families` — exercised by these scenario families, which the declaring
 *   provider must therefore run.
 * - `shared` — exercised INDIRECTLY, by conformance over a shared
 *   implementation the provider delegates to rather than by a provider-specific
 *   scenario. Stated so the arrangement is visible; an absent scenario must
 *   never simply read as coverage.
 * - `gap` — no conformance scenario exists in any family yet. Written down so
 *   the absence is a debt rather than something nobody can see. A provider
 *   declaring it is NOT failed for the missing scenario.
 */
export type SandboxCapabilityCoverage =
  | { readonly kind: 'families'; readonly families: readonly SandboxConformanceFamily[] }
  | { readonly kind: 'shared'; readonly by: string }
  | { readonly kind: 'gap'; readonly why: string };

/**
 * Coverage for every capability. TOTAL over the vocabulary: a capability added
 * without an entry here is a compile error, so a new capability cannot enter the
 * vocabulary both uncovered AND unrecorded.
 *
 * The `families` entries are not guesses — each is the family whose source
 * actually branches on that capability:
 *   - `conformance.ts:349` (provider family) branches on `lifecycle.readopt`
 *   - `conformance.ts:437-444, 981-1040` (behavior family) branches on
 *     `terminal.interactive`, `command.exec`, `workspace.git.*`,
 *     `workspace.archive.transfer`, `lifecycle.readopt`, `lifecycle.sleep`,
 *     `lifecycle.snapshot`
 *   - `diagnostic-conformance.ts` branches on `workspace.git.materialize` and
 *     `workspace.git.deliver`
 */
export const SANDBOX_CAPABILITY_CONFORMANCE_COVERAGE: Readonly<
  Record<SandboxProviderCapability, SandboxCapabilityCoverage>
> = {
  // The base transport every provider suite provisions and attaches over. No
  // family names it because every scenario depends on it existing.
  'terminal.websocket': { kind: 'families', families: ['provider'] },
  'terminal.interactive': { kind: 'families', families: ['behavior'] },
  // Behaviour AND output settlement: declaring command execution obliges both.
  'command.exec': { kind: 'families', families: ['behavior', 'command-output'] },
  'workspace.git.materialize': {
    kind: 'families',
    families: ['behavior', 'diagnostic'],
  },
  'workspace.git.deliver': {
    kind: 'families',
    families: ['behavior', 'diagnostic'],
  },
  'workspace.archive.transfer': { kind: 'families', families: ['behavior'] },
  'transcript.retained-read': { kind: 'families', families: ['provider'] },
  'lifecycle.readopt': { kind: 'families', families: ['provider', 'behavior'] },
  'lifecycle.sleep': { kind: 'families', families: ['behavior'] },
  'lifecycle.snapshot': { kind: 'families', families: ['behavior'] },

  // --- Enumerated gaps ------------------------------------------------------
  // These are declared by shipped providers (AIO declares both workspace-source
  // variants below; BoxLite declares the retained transcript source) and no
  // family exercises them. Recorded rather than demanded: writing those
  // scenarios is its own piece of work with its own contract to design.
  'workspace.source.volume': {
    kind: 'gap',
    why: 'workspace-source injection has no conformance scenario yet; AIO declares it',
  },
  'workspace.source.archive': {
    kind: 'gap',
    why: 'workspace-source injection has no conformance scenario yet',
  },
  'workspace.source.git': {
    kind: 'gap',
    why: 'workspace-source injection has no conformance scenario yet; AIO declares it',
  },
  'transcript.retained-source': {
    kind: 'gap',
    why: 'retained transcript SOURCE (as distinct from retained read) has no scenario yet; BoxLite declares it',
  },
  'resource.disk-size-gb': {
    kind: 'gap',
    why: 'no scenario; BoxLite native mode resolves it into its declared set',
  },
  'port.expose': {
    kind: 'gap',
    why: 'no scenario, and no shipped provider declares it',
  },
};

/** The families a provider owes, given what it declares. */
export function requiredConformanceFamilies(
  declared: readonly SandboxProviderCapability[],
): readonly SandboxConformanceFamily[] {
  const required = new Set<SandboxConformanceFamily>();
  for (const capability of declared) {
    const coverage = SANDBOX_CAPABILITY_CONFORMANCE_COVERAGE[capability];
    if (coverage?.kind !== 'families') continue;
    for (const family of coverage.families) required.add(family);
  }
  return [...required];
}

/** The declared capabilities that are covered by nothing, with the reason. */
export function declaredConformanceGaps(
  declared: readonly SandboxProviderCapability[],
): readonly { readonly capability: SandboxProviderCapability; readonly why: string }[] {
  return declared.flatMap((capability) => {
    const coverage = SANDBOX_CAPABILITY_CONFORMANCE_COVERAGE[capability];
    return coverage?.kind === 'gap' ? [{ capability, why: coverage.why }] : [];
  });
}

/**
 * A ledger of which families a provider's conformance run actually exercised.
 *
 * The provider's test says which family each suite it builds BELONGS TO; what is
 * REQUIRED is computed from the provider's declared capabilities alone. So a
 * family cannot be dropped by simply not mentioning it — dropping it means the
 * required set still contains it and `assertComplete()` fails, naming the
 * capability that obliged it.
 *
 * (A stronger shape would make a partial run unexpressible by building every
 * suite from one call site. The three provider suites construct their fixtures
 * in separate scopes today, so that is a test restructure of its own; this
 * ledger delivers the enforcement without it.)
 */
export interface ConformanceParticipationLedger {
  /** Record that a family's suite ran. */
  ran(family: SandboxConformanceFamily): void;
  /** Throw unless every family the declared capabilities require has run. */
  assertComplete(): void;
}

export function createConformanceParticipationLedger(args: {
  readonly providerLabel: string;
  readonly declaredCapabilities: readonly SandboxProviderCapability[];
  readonly onGap?: (capability: SandboxProviderCapability, why: string) => void;
}): ConformanceParticipationLedger {
  const seen = new Set<SandboxConformanceFamily>();
  for (const { capability, why } of declaredConformanceGaps(args.declaredCapabilities)) {
    args.onGap?.(capability, why);
  }
  return {
    ran(family) {
      seen.add(family);
    },
    assertComplete() {
      const missing = requiredConformanceFamilies(args.declaredCapabilities).filter(
        (family) => !seen.has(family),
      );
      if (missing.length === 0) return;
      const detail = missing
        .map((family) => {
          const owed = args.declaredCapabilities.filter((capability) => {
            const coverage = SANDBOX_CAPABILITY_CONFORMANCE_COVERAGE[capability];
            return coverage?.kind === 'families' && coverage.families.includes(family);
          });
          return `"${family}" (required by ${owed.join(', ')})`;
        })
        .join('; ');
      throw new Error(
        `conformance participation: ${args.providerLabel} declares capabilities requiring ` +
          `${detail}, but ${missing.length === 1 ? 'that family' : 'those families'} did not run. ` +
          'A provider may not advertise a capability its conformance does not exercise.',
      );
    },
  };
}

export interface RequiredConformanceRun {
  /** What the provider declares. The obligation is derived from this alone. */
  readonly declaredCapabilities: readonly SandboxProviderCapability[];
  /**
   * The suites this caller can build, by family. A family that is REQUIRED but
   * absent here is the failure this module exists to produce — it is how a
   * provider used to quietly cover less than it advertised.
   */
  readonly suites: Partial<
    Record<SandboxConformanceFamily, () => readonly SandboxProviderConformanceScenario[]>
  >;
  /** Reported for visibility; never used to skip a family. */
  readonly onGap?: (capability: SandboxProviderCapability, why: string) => void;
}

/**
 * Resolve the scenarios a provider owes, refusing a declared capability whose
 * family was not supplied.
 *
 * Note what is NOT possible here: running a subset. The caller does not choose
 * which families to run, it supplies what it can build and this decides.
 */
export function resolveRequiredConformanceScenarios(
  run: RequiredConformanceRun,
): readonly SandboxProviderConformanceScenario[] {
  for (const { capability, why } of declaredConformanceGaps(run.declaredCapabilities)) {
    run.onGap?.(capability, why);
  }

  const scenarios: SandboxProviderConformanceScenario[] = [];
  for (const family of requiredConformanceFamilies(run.declaredCapabilities)) {
    const build = run.suites[family];
    if (!build) {
      const owed = run.declaredCapabilities.filter((capability) => {
        const coverage = SANDBOX_CAPABILITY_CONFORMANCE_COVERAGE[capability];
        return coverage?.kind === 'families' && coverage.families.includes(family);
      });
      throw new Error(
        `conformance participation: this provider declares ${owed.join(', ')}, ` +
          `which the "${family}" family exercises, but no "${family}" suite was supplied. ` +
          'A provider may not advertise a capability its conformance does not exercise.',
      );
    }
    scenarios.push(...build());
  }
  return scenarios;
}
