import type { AgentRuntimeId } from '@cap-console/contracts';

import type { RuntimeHarnessMaker } from './harness.js';
import type {
  RuntimeConformanceFamily,
  RuntimeFamilyObligation,
} from './participation.js';

/**
 * Compile-fail fixtures for the participation ledger pair — the same
 * self-invalidating `@ts-expect-error` form as the api's
 * `agent-runtime-registration.typecheck.ts`.
 *
 * A test can prove that today's ledger matches today's declarations. Only the
 * compiler can prove that TOMORROW's declared runtime cannot land without a
 * ledger entry — a declared-but-unregistered runtime must fail typecheck
 * naming the missing key, before any test executes.
 *
 * These assignments deliberately stay behind `@ts-expect-error`. If either
 * ledger Record is ever weakened to a `Partial` or an index-signature shape —
 * which would restore the silent-skip behaviour this suite exists to remove —
 * the directives become unused and the ordinary typecheck fails. The fixture
 * cannot be defeated by relaxing the thing it guards.
 */

type HarnessLedger = Readonly<Record<AgentRuntimeId, RuntimeHarnessMaker>>;

declare const withoutClaudeCode: Omit<HarnessLedger, 'claude-code'>;

// @ts-expect-error Every declared runtime must have a harness-maker ledger entry.
const missingRuntimeEntry: HarnessLedger = withoutClaudeCode;
void missingRuntimeEntry;

declare const partialHarnesses: Partial<HarnessLedger>;

// @ts-expect-error The runtime-keyed ledger must be total, not partial.
const partialIsNotTotal: HarnessLedger = partialHarnesses;
void partialIsNotTotal;

type FamilyLedger = Readonly<
  Record<RuntimeConformanceFamily, RuntimeFamilyObligation>
>;

declare const withoutHeadless: Omit<FamilyLedger, 'headless'>;

// @ts-expect-error Every scenario family must have an obligation entry.
const missingFamilyEntry: FamilyLedger = withoutHeadless;
void missingFamilyEntry;

declare const partialFamilies: Partial<FamilyLedger>;

// @ts-expect-error The family-keyed ledger must be total, not partial.
const partialFamiliesAreNotTotal: FamilyLedger = partialFamilies;
void partialFamiliesAreNotTotal;

/** An identifier outside the declaration is not a runtime ledger key. */
declare const arbitrary: string;

// @ts-expect-error Ledger keys come from the contracts declaration, not free strings.
const unmodelledKey: keyof HarnessLedger = arbitrary;
void unmodelledKey;
