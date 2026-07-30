/**
 * Provisioning-level detached-job marker probe triage (detach-workspace-clone
 * D9). Owned by the admission claim/processor path: a parked row whose lease
 * expired (or whose job settled) re-enters through the ordinary claim query,
 * and guardrails — processing that claim — supplies this decision function to
 * the staged materialization's resume seam so marker evidence gathered through
 * the sandbox exec channel is triaged by the claim path before any further
 * provider work. It never runs from a NestJS bootstrap hook, so recovery
 * cannot depend on `onApplicationBootstrap` ordering between providers;
 * `readoptSurvivorsOnStartup` stays the unchanged owner of
 * agent_launch-and-later recovery.
 *
 * This module is deliberately free of NestJS/service imports so both the
 * processor adapter and GuardrailsService can consume it without a cycle.
 */
export type ParkedAdmissionMarkerTriage =
  | 'keep_parked'
  | 'settle_from_exit'
  | 'fail_attempt';

/** Safe marker evidence for one detached job; carries no output or command. */
export interface ParkedAdmissionMarkerProbe {
  /** The pid marker names a process that is provably still alive. */
  readonly pidAlive: boolean;
  /** Recorded exit marker, the ONLY settlement proof a job can produce. */
  readonly exitMarker: { readonly exitCode: number } | null;
  /**
   * Whether the progress marker showed any output/growth. Deliberately part of
   * the probe shape AND deliberately ignored by the triage: the progress file
   * is an output stream, never a settlement source — success must not be
   * inferred from progress contents or silence.
   */
  readonly progressObserved?: boolean;
}

/**
 * Three-way triage contract for parked admission work, shared by resume-time
 * claims and API-restart recovery (both arrive through the same claim path):
 *
 *  - exit marker present -> settle the transfer stage from its recorded code
 *    (the atomic workspace publish precedes the exit marker, so a half-written
 *    tree can never be triaged as success);
 *  - pid provably alive (and no exit marker) -> the job is still running; the
 *    work stays parked;
 *  - neither provable -> fail the attempt. Never infer success.
 */
export function triageParkedAdmissionMarkers(
  probe: ParkedAdmissionMarkerProbe,
): ParkedAdmissionMarkerTriage {
  // Exit marker first: it is the terminal settlement proof, written by the
  // wrapper strictly after the child exited and the workspace was published.
  // A still-alive wrapper pid must not mask an already-recorded settlement.
  if (probe.exitMarker) return 'settle_from_exit';
  if (probe.pidAlive) return 'keep_parked';
  return 'fail_attempt';
}
