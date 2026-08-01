/**
 * @cap-console/runtime-conformance — the agent-runtime conformance suite
 * (unlock-extension-axes, design D7).
 *
 * Layout follows go-cloud's drivertest: the suite owns ALL scenario logic;
 * each runtime participates through a harness maker (construction + environment
 * hooks) registered in a compile-time-total participation ledger. Every run
 * emits a per-runtime report mapping each scenario family to pass/skip with a
 * reason — an undeclared capability is a reasoned skip row, never silence.
 */
export * from './harness.js';
export * from './participation.js';
export { RUNTIME_CONFORMANCE_HARNESSES } from './registry.js';
export * from './report.js';
export {
  SCENARIO_FAMILIES,
  runFamiliesFor,
  runRuntimeConformance,
  type RuntimeConformanceRunOptions,
} from './run.js';
