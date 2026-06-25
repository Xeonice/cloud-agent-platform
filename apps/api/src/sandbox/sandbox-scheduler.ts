import {
  buildSandboxProvisionPlan as buildCoreSandboxProvisionPlan,
  type SandboxProvisionPlan as CoreSandboxProvisionPlan,
} from '@cap/sandbox';
import type { CloneSpec } from './provision-lookup.port';

export {
  DELIVERY_SANDBOX_REQUIRED_CAPABILITIES,
  INTERACTIVE_SANDBOX_REQUIRED_CAPABILITIES,
  MATERIALIZED_WORKSPACE_SANDBOX_REQUIRED_CAPABILITIES,
  READOPTION_SANDBOX_REQUIRED_CAPABILITIES,
  RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES,
  provisionSandboxRequiredCapabilities,
  selectConfiguredSandboxProvider,
  selectDeliverySandboxProvider,
  selectReadoptionSandboxProvider,
  selectRetainedTranscriptSandboxProvider,
  selectSandboxProvider,
  selectSandboxProviderCandidate,
  buildSandboxSettlePlan,
  forceFailSettlePlan,
  terminalSettlePlan,
} from '@cap/sandbox';

export type {
  GitCloneSpec,
  SandboxCapabilitySource,
  SandboxProviderCandidate,
  SandboxProviderCandidateSelection,
  SandboxProviderCompatibility,
  SandboxProviderLocation,
  SandboxProviderSelection,
  SandboxSettlePlan,
  SelectSandboxProviderCandidateOptions,
} from '@cap/sandbox';

export type SandboxProvisionPlan = CoreSandboxProvisionPlan<CloneSpec>;

export function buildSandboxProvisionPlan(args: {
  readonly cloneSpec: CloneSpec | null | undefined;
}): SandboxProvisionPlan {
  return buildCoreSandboxProvisionPlan({ cloneSpec: args.cloneSpec });
}
