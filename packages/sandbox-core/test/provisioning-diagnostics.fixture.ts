import type {
  SandboxProvisionContext,
  SandboxProvisioningDiagnosticAttemptContext,
  SandboxProvisioningDiagnosticEmitter,
  SandboxProvisioningDiagnosticFact,
  SandboxProvisioningDiagnosticObserver,
} from '../src/index.js';

declare const diagnostics: SandboxProvisioningDiagnosticEmitter;
declare const tasklessObserver: SandboxProvisioningDiagnosticObserver;

const attemptContext: SandboxProvisioningDiagnosticAttemptContext = {
  schemaVersion: 1,
  taskId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  attempt: 1,
  admissionMode: 'durable',
  providerFamily: 'unknown',
};
void attemptContext;

const started: SandboxProvisioningDiagnosticFact = {
  operationId: '33333333-3333-4333-8333-333333333333',
  stage: 'provider_selection',
  operation: 'provider_select',
  channel: 'primary',
  outcome: 'started',
};
void diagnostics.emit(started);
void tasklessObserver.emit(started);
void diagnostics.flush();
void tasklessObserver.flush();

const terminal: SandboxProvisioningDiagnosticFact = {
  operationId: '33333333-3333-4333-8333-333333333333',
  stage: 'native_execution',
  operation: 'native_exec_settlement',
  channel: 'primary',
  commandKind: 'runtime_setup',
  outcome: 'failed',
  durationMs: 10,
  cause: 'missing_exit_code',
  retryable: false,
  httpStatusClass: null,
  nativeState: 'failed',
  anomaly: 'missing_exit_code',
  exitCode: null,
  timeoutMs: null,
};
void diagnostics.emit(terminal);

const providerSelectedTask: SandboxProvisioningDiagnosticFact = {
  ...started,
  // @ts-expect-error correlation identity belongs to the emitter, not a provider fact
  taskId: '11111111-1111-4111-8111-111111111111',
};
void providerSelectedTask;

const providerRawOutput: SandboxProvisioningDiagnosticFact = {
  ...terminal,
  // @ts-expect-error raw provider output is not a diagnostic fact
  output: 'secret',
};
void providerRawOutput;

// @ts-expect-error a started fact cannot carry terminal failure data
const startedWithTerminalCause: SandboxProvisioningDiagnosticFact = {
  ...started,
  cause: 'unknown',
};
void startedWithTerminalCause;

const contextWithDiagnostics: SandboxProvisionContext = {
  taskId: '11111111-1111-4111-8111-111111111111',
  diagnostics,
  modelIntent: { kind: 'runtime-default' },
  runtimeId: 'codex',
  executionMode: 'headless-exec',
};
void contextWithDiagnostics;

const legacyContextWithoutDiagnostics: SandboxProvisionContext = {
  taskId: 'legacy-task',
  modelIntent: { kind: 'runtime-default' },
  runtimeId: 'codex',
  executionMode: 'headless-exec',
};
void legacyContextWithoutDiagnostics;

// @ts-expect-error a taskless observer has no attempt identity or recorder
const tasklessAsEmitter: SandboxProvisioningDiagnosticEmitter = tasklessObserver;
void tasklessAsEmitter;
