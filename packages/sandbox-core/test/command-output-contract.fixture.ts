import type { SandboxCommandExecutionResult } from '../src/index.js';

const provenEmptyOutput: SandboxCommandExecutionResult = {
  exitCode: 0,
  output: '',
  stdout: '',
  stderr: '',
  timedOut: false,
};
void provenEmptyOutput;

const rejectedPartialOutput: SandboxCommandExecutionResult = {
  exitCode: 0,
  output: '',
  stdout: '',
  stderr: '',
  timedOut: false,
  // @ts-expect-error successful results have no partial-output escape hatch
  outputComplete: false,
};
void rejectedPartialOutput;
