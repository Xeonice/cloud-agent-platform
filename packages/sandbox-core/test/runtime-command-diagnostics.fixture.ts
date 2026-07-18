import type {
  SandboxRuntimePreflightCommandDescriptor,
  SandboxRuntimeSetupCommandDescriptor,
} from '../src/index.js';

const preflight: SandboxRuntimePreflightCommandDescriptor = {
  commandKind: 'runtime_preflight',
  ordinal: 1,
};
void preflight;

const setup: SandboxRuntimeSetupCommandDescriptor = {
  commandKind: 'credential_setup',
  ordinal: 1,
};
void setup;

const promptSetup: SandboxRuntimeSetupCommandDescriptor = {
  commandKind: 'runtime_setup',
  ordinal: 2,
};
void promptSetup;

const rawCommand = {
  commandKind: 'runtime_setup' as const,
  ordinal: 1,
  command: 'contains secret material',
};
// @ts-expect-error the safe descriptor cannot structurally carry command text
const rejectedRawCommand: SandboxRuntimeSetupCommandDescriptor = rawCommand;
void rejectedRawCommand;

const rawOutput = {
  commandKind: 'runtime_preflight' as const,
  ordinal: 1,
  output: 'contains provider output',
};
// @ts-expect-error the safe descriptor cannot structurally carry provider output
const rejectedRawOutput: SandboxRuntimePreflightCommandDescriptor = rawOutput;
void rejectedRawOutput;

const wrongPreflightKind: SandboxRuntimePreflightCommandDescriptor = {
  // @ts-expect-error a preflight descriptor has exactly one allowlisted kind
  commandKind: 'runtime_setup',
  ordinal: 1,
};
void wrongPreflightKind;

const wrongSetupKind: SandboxRuntimeSetupCommandDescriptor = {
  // @ts-expect-error runtime setup plans cannot claim a Git operation kind
  commandKind: 'git_clone',
  ordinal: 1,
};
void wrongSetupKind;
