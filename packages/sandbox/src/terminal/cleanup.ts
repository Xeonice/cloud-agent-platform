import type { TerminalTransportCleanupSettlement } from '@cap/sandbox-core';

type IndeterminateCleanupCause = Extract<
  TerminalTransportCleanupSettlement,
  { kind: 'indeterminate' }
>['cause'];

/** A cleanup decision for a path that provably opened no provider identity. */
export function confirmedEmptyTerminalCleanupSettlement(): TerminalTransportCleanupSettlement {
  return {
    kind: 'confirmed',
    expectedIdentities: 0,
    observedIdentities: 0,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    cause: null,
  };
}

/** Identity-free failure evidence for one expected outer provider PTY. */
export function indeterminateTerminalCleanupSettlement(
  cause: IndeterminateCleanupCause,
  expectedIdentities = 1,
): TerminalTransportCleanupSettlement {
  return {
    kind: 'indeterminate',
    expectedIdentities: nonNegativeSafeInteger(expectedIdentities),
    observedIdentities: 0,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    cause,
  };
}

/**
 * Normalize the optional provider seam into a non-rejecting decision. Missing
 * providers remain explicitly indeterminate; a rejection cannot escape a
 * graceful-shutdown hook or be mistaken for confirmed absence.
 */
export function normalizeTerminalCleanupDecision(
  decision: Promise<TerminalTransportCleanupSettlement> | undefined,
  expectedIdentities = 1,
): Promise<TerminalTransportCleanupSettlement> {
  if (!decision) {
    return Promise.resolve(
      indeterminateTerminalCleanupSettlement(
        'cleanup-unsupported',
        expectedIdentities,
      ),
    );
  }
  return decision.then(
    (settlement) => sanitizeTerminalCleanupSettlement(settlement),
    () =>
      indeterminateTerminalCleanupSettlement(
        'cleanup-unconfirmed',
        expectedIdentities,
      ),
  );
}

/** Aggregate multiple transport generations without exposing their identities. */
export function aggregateTerminalCleanupSettlements(
  settlements: readonly TerminalTransportCleanupSettlement[],
): TerminalTransportCleanupSettlement {
  if (settlements.length === 0) {
    return confirmedEmptyTerminalCleanupSettlement();
  }
  const safe = settlements.map(sanitizeTerminalCleanupSettlement);
  const counts = safe.reduce(
    (total, settlement) => ({
      expectedIdentities: safeAdd(
        total.expectedIdentities,
        settlement.expectedIdentities,
      ),
      observedIdentities: safeAdd(
        total.observedIdentities,
        settlement.observedIdentities,
      ),
      confirmedIdentities: safeAdd(
        total.confirmedIdentities,
        settlement.confirmedIdentities,
      ),
      deletedIdentities: safeAdd(
        total.deletedIdentities,
        settlement.deletedIdentities,
      ),
      alreadyAbsentIdentities: safeAdd(
        total.alreadyAbsentIdentities,
        settlement.alreadyAbsentIdentities,
      ),
    }),
    {
      expectedIdentities: 0,
      observedIdentities: 0,
      confirmedIdentities: 0,
      deletedIdentities: 0,
      alreadyAbsentIdentities: 0,
    },
  );
  const indeterminate = safe.filter(
    (settlement): settlement is Extract<
      TerminalTransportCleanupSettlement,
      { kind: 'indeterminate' }
    > => settlement.kind === 'indeterminate',
  );
  if (indeterminate.length === 0) {
    return { kind: 'confirmed', ...counts, cause: null };
  }
  return {
    kind: 'indeterminate',
    ...counts,
    cause: aggregateIndeterminateCause(indeterminate.map(({ cause }) => cause)),
  };
}

function sanitizeTerminalCleanupSettlement(
  settlement: TerminalTransportCleanupSettlement,
): TerminalTransportCleanupSettlement {
  const expectedIdentities = nonNegativeSafeInteger(
    settlement.expectedIdentities,
  );
  const observedIdentities = nonNegativeSafeInteger(
    settlement.observedIdentities,
  );
  const confirmedIdentities = nonNegativeSafeInteger(
    settlement.confirmedIdentities,
  );
  const deletedIdentities = nonNegativeSafeInteger(
    settlement.deletedIdentities,
  );
  const alreadyAbsentIdentities = nonNegativeSafeInteger(
    settlement.alreadyAbsentIdentities,
  );
  const countsAreConsistent =
    observedIdentities <= expectedIdentities &&
    confirmedIdentities <= observedIdentities &&
    deletedIdentities + alreadyAbsentIdentities === confirmedIdentities;
  if (!countsAreConsistent) {
    return indeterminateTerminalCleanupSettlement(
      'cleanup-unconfirmed',
      expectedIdentities,
    );
  }
  if (settlement.kind === 'confirmed') {
    if (confirmedIdentities !== expectedIdentities) {
      return {
        kind: 'indeterminate',
        expectedIdentities,
        observedIdentities,
        confirmedIdentities,
        deletedIdentities,
        alreadyAbsentIdentities,
        cause: 'cleanup-unconfirmed',
      };
    }
    return {
      kind: 'confirmed',
      expectedIdentities,
      observedIdentities,
      confirmedIdentities,
      deletedIdentities,
      alreadyAbsentIdentities,
      cause: null,
    };
  }
  return {
    kind: 'indeterminate',
    expectedIdentities,
    observedIdentities,
    confirmedIdentities,
    deletedIdentities,
    alreadyAbsentIdentities,
    cause: settlement.cause,
  };
}

function aggregateIndeterminateCause(
  causes: readonly IndeterminateCleanupCause[],
): IndeterminateCleanupCause {
  if (causes.includes('cleanup-unconfirmed')) return 'cleanup-unconfirmed';
  if (causes.includes('cleanup-unsupported')) return 'cleanup-unsupported';
  return 'identity-unavailable';
}

function nonNegativeSafeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeAdd(left: number, right: number): number {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}
