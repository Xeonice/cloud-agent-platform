/**
 * The runtime-keyed half of the participation ledger pair (the family-keyed
 * half is `RUNTIME_FAMILY_OBLIGATIONS` in `./participation.ts`).
 *
 * TOTAL over the contracts runtime vocabulary: a runtime id added to
 * `AGENT_RUNTIME_IDS` without a harness maker here is a COMPILE error naming
 * the missing key — never a runtime detection, never a silent skip. Admitting
 * a runtime to the suite is exactly one entry here plus its harness maker
 * (construction + hooks); the scenario families never change.
 */
import type { AgentRuntimeId } from '@cap-console/contracts';

import type { RuntimeHarnessMaker } from './harness.js';
import { claudeCodeHarnessMaker } from './runtimes/claude-code.harness.js';
import { codexHarnessMaker } from './runtimes/codex.harness.js';

export const RUNTIME_CONFORMANCE_HARNESSES: Readonly<
  Record<AgentRuntimeId, RuntimeHarnessMaker>
> = {
  codex: codexHarnessMaker,
  'claude-code': claudeCodeHarnessMaker,
};
