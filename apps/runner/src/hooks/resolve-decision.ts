import type { Decision, DecisionBehavior } from '@cap/contracts';

/**
 * Any-deny-wins resolution (agent-events-and-approvals spec, "Any-deny-wins
 * resolution").
 *
 * When more than one matching decision is produced for a single permission
 * request, the outcome resolves to `deny` if ANY contributing decision is
 * `deny`, and to `allow` ONLY when EVERY contributing decision is `allow`.
 *
 * An empty set of decisions is treated as having no `allow` consensus and
 * therefore resolves to `deny` (fail-closed): there is no contributing decision
 * that says `allow`, so it cannot be safe to allow.
 *
 * The first contributing `deny`'s message (if any) is preserved on the resolved
 * decision so the operator's reason reaches Codex; otherwise the first
 * available message is carried through.
 */
export function resolveDecisions(decisions: readonly Decision[]): Decision {
  if (decisions.length === 0) {
    return { behavior: 'deny' };
  }

  const firstDeny = decisions.find((d) => d.behavior === 'deny');
  if (firstDeny) {
    return firstDeny.message !== undefined
      ? { behavior: 'deny', message: firstDeny.message }
      : { behavior: 'deny' };
  }

  // Every contributing decision is `allow`.
  const behavior: DecisionBehavior = 'allow';
  const firstWithMessage = decisions.find((d) => d.message !== undefined);
  return firstWithMessage?.message !== undefined
    ? { behavior, message: firstWithMessage.message }
    : { behavior };
}
