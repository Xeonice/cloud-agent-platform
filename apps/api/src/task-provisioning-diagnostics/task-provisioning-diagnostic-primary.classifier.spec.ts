import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SandboxProviderCapabilityError,
  SandboxProviderConfigurationError,
  SandboxProviderSelectionError,
  SandboxProvisioningCapacityError,
  SandboxProvisioningStageError,
  SandboxRuntimeModelSetupError,
  SandboxWorkspaceMaterializationError,
  type RuntimeModelSetupFailurePhase,
  type SandboxWorkspaceOperationFailure,
} from '@cap/sandbox';

import {
  TaskBranchResolutionError,
  type TaskBranchResolutionFailureReason,
} from '../forge/task-branch-resolver';
import { TaskAdmissionProcessingError } from '../task-admission/task-admission.types';
import type { ProvisioningTaskFailureCode } from '../tasks/task-failure';
import {
  classifyTaskProvisioningDiagnosticPrimaryFailure,
  taskProvisioningDiagnosticCauseFromFailureCode,
  type ClassifiedTaskProvisioningDiagnosticPrimaryFailure,
} from './task-provisioning-diagnostic-primary.classifier';

const RAW_CANARY = 'diagnostic-primary-raw-canary';

const BASE_FAILURE = Object.freeze({
  state: 'failed' as const,
  retryable: false,
  exitCode: null,
});

describe('task provisioning diagnostic primary classifier', () => {
  it('maps every admission cause and preserves only its typed retryability', () => {
    const cases: readonly [
      ProvisioningTaskFailureCode,
      ClassifiedTaskProvisioningDiagnosticPrimaryFailure['outcome'],
      ClassifiedTaskProvisioningDiagnosticPrimaryFailure['cause'],
    ][] = [
      ['provisioning_capacity_exhausted', 'failed', 'capacity_exhausted'],
      ['provisioning_workspace_timeout', 'timed_out', 'workspace_timeout'],
      ['provisioning_forge_auth_failed', 'failed', 'authentication_failed'],
      ['provisioning_tls_network_failed', 'failed', 'tls_network_failed'],
      ['provisioning_ref_not_found', 'failed', 'ref_not_found'],
      [
        'provisioning_platform_dependency_unavailable',
        'failed',
        'provider_unavailable',
      ],
      ['provisioning_unknown', 'failed', 'unknown'],
    ];

    for (const [causeCode, outcome, cause] of cases) {
      assert.equal(
        taskProvisioningDiagnosticCauseFromFailureCode(causeCode),
        cause,
      );
      assert.deepEqual(
        classifyTaskProvisioningDiagnosticPrimaryFailure(
          new TaskAdmissionProcessingError(
            causeCode,
            'workspace_transfer',
            true,
          ),
          'sandbox_creation',
        ),
        {
          ...BASE_FAILURE,
          stage: 'workspace_transfer',
          operation: 'repository_transfer',
          commandKind: 'git_clone',
          outcome,
          cause,
          retryable: true,
        },
      );
    }
    assert.equal(
      taskProvisioningDiagnosticCauseFromFailureCode(null),
      'unknown',
    );
    assert.equal(
      taskProvisioningDiagnosticCauseFromFailureCode(undefined),
      'unknown',
    );
  });

  it('uses one explicit closed operation and command-kind mapping for every task stage', () => {
    const cases = [
      ['accepted', 'provider_select', undefined],
      ['sandbox_creation', 'sandbox_create', undefined],
      ['credential_setup', 'credential_setup', 'credential_setup'],
      [
        'remote_ref_resolution',
        'remote_ref_resolve',
        'git_remote_ref',
      ],
      ['workspace_transfer', 'repository_transfer', 'git_clone'],
      ['checkout', 'checkout', 'git_checkout'],
      ['submodules', 'submodules', 'git_submodules'],
      [
        'credential_cleanup',
        'credential_cleanup',
        'credential_cleanup',
      ],
      ['runtime_setup', 'runtime_setup', 'runtime_setup'],
      ['readiness', 'runtime_preflight', 'runtime_preflight'],
      ['agent_launch', 'agent_launch', 'agent_launch'],
      ['complete', 'agent_launch', 'agent_launch'],
    ] as const;

    for (const [stage, operation, commandKind] of cases) {
      const classified = classifyTaskProvisioningDiagnosticPrimaryFailure(
        new TaskAdmissionProcessingError(
          'provisioning_unknown',
          stage,
          false,
        ),
        'sandbox_creation',
      );
      assert.equal(classified.stage, stage);
      assert.equal(classified.operation, operation);
      assert.equal(classified.commandKind, commandKind);
      assert.equal(classified.cause, 'unknown');
    }
  });

  it('uses explicit operations for diagnostic-only fallback stages', () => {
    const cases = [
      ['provider_selection', 'provider_select', undefined],
      ['sandbox_start', 'sandbox_start', undefined],
      ['sandbox_inspect', 'sandbox_inspect', undefined],
      ['native_execution', 'native_exec_settlement', undefined],
      ['settlement', 'native_exec_settlement', undefined],
      ['cleanup', 'sandbox_delete', 'sandbox_cleanup'],
    ] as const;

    for (const [stage, operation, commandKind] of cases) {
      const classified = classifyTaskProvisioningDiagnosticPrimaryFailure(
        new Error(RAW_CANARY),
        stage,
      );
      assert.equal(classified.stage, stage);
      assert.equal(classified.operation, operation);
      assert.equal(classified.commandKind, commandKind);
      assert.equal(classified.cause, 'unknown');
    }
  });

  it('keeps branch authentication, access, TLS, ref, and dependency causes distinct', () => {
    const cases: readonly [
      TaskBranchResolutionFailureReason,
      ClassifiedTaskProvisioningDiagnosticPrimaryFailure['cause'],
      boolean,
    ][] = [
      ['task_not_found', 'unknown', false],
      ['repository_unavailable', 'ref_not_found', false],
      ['explicit_branch_invalid', 'ref_not_found', false],
      ['repo_default_branch_invalid', 'ref_not_found', false],
      ['snapshot_invalid', 'ref_not_found', false],
      ['snapshot_conflict', 'ref_not_found', false],
      ['owner_credential_unavailable', 'authentication_failed', false],
      ['authentication_failed', 'authentication_failed', false],
      ['access_denied', 'access_denied', false],
      ['network_unavailable', 'tls_network_failed', true],
      ['platform_dependency_unavailable', 'provider_unavailable', false],
      ['branch_not_found', 'ref_not_found', false],
    ];

    for (const [reason, cause, retryable] of cases) {
      assert.deepEqual(
        classifyTaskProvisioningDiagnosticPrimaryFailure(
          new TaskBranchResolutionError(reason),
          'sandbox_creation',
        ),
        {
          ...BASE_FAILURE,
          stage: 'remote_ref_resolution',
          operation: 'remote_ref_resolve',
          commandKind: 'git_remote_ref',
          outcome: 'failed',
          cause,
          retryable,
        },
      );
    }
  });

  it('maps every workspace failure cause without trusting its raw error text', () => {
    const cases: readonly [
      Extract<SandboxWorkspaceOperationFailure, { readonly status: 'failed' }>['cause'],
      ClassifiedTaskProvisioningDiagnosticPrimaryFailure['outcome'],
      ClassifiedTaskProvisioningDiagnosticPrimaryFailure['cause'],
      boolean,
    ][] = [
      ['capacity_exhausted', 'failed', 'capacity_exhausted', false],
      ['timeout', 'timed_out', 'workspace_timeout', false],
      ['authentication', 'failed', 'authentication_failed', false],
      ['tls_network', 'failed', 'tls_network_failed', true],
      ['ref_not_found', 'failed', 'ref_not_found', false],
      ['unknown', 'failed', 'unknown', false],
    ];

    for (const [workspaceCause, outcome, cause, retryable] of cases) {
      const error = new SandboxWorkspaceMaterializationError({
        status: 'failed',
        stage: 'workspace_transfer',
        cause: workspaceCause,
        retryable: true,
      });
      Object.defineProperties(error, {
        cause: { value: new Error(RAW_CANARY) },
        stack: { value: RAW_CANARY },
      });
      assert.deepEqual(
        classifyTaskProvisioningDiagnosticPrimaryFailure(
          error,
          'sandbox_creation',
        ),
        {
          ...BASE_FAILURE,
          stage: 'workspace_transfer',
          operation: 'repository_transfer',
          commandKind: 'git_clone',
          outcome,
          cause,
          retryable,
        },
      );
    }
  });

  it('maps each workspace stage, including credential cleanup, as primary outer evidence', () => {
    const cases = [
      ['credential_setup', 'credential_setup', 'credential_setup'],
      [
        'remote_ref_resolution',
        'remote_ref_resolve',
        'git_remote_ref',
      ],
      ['workspace_transfer', 'repository_transfer', 'git_clone'],
      ['checkout', 'checkout', 'git_checkout'],
      ['submodules', 'submodules', 'git_submodules'],
      [
        'credential_cleanup',
        'credential_cleanup',
        'credential_cleanup',
      ],
    ] as const;

    for (const [stage, operation, commandKind] of cases) {
      const classified = classifyTaskProvisioningDiagnosticPrimaryFailure(
        new SandboxWorkspaceMaterializationError({
          status: 'failed',
          stage,
          cause: 'unknown',
          retryable: false,
        }),
        'sandbox_creation',
      );
      assert.equal(classified.stage, stage);
      assert.equal(classified.operation, operation);
      assert.equal(classified.commandKind, commandKind);
    }
  });

  it('preserves typed workspace cancellation independently from timeout', () => {
    assert.deepEqual(
      classifyTaskProvisioningDiagnosticPrimaryFailure(
        new SandboxWorkspaceMaterializationError({
          status: 'cancelled',
          stage: 'checkout',
        }),
        'sandbox_creation',
      ),
      {
        ...BASE_FAILURE,
        state: 'cancelled',
        stage: 'checkout',
        operation: 'checkout',
        commandKind: 'git_checkout',
        outcome: 'cancelled',
        cause: 'cancelled',
      },
    );
  });

  it('classifies typed and structural capacity failures', () => {
    for (const error of [
      new SandboxProvisioningCapacityError(),
      {
        code: 'sandbox_provisioning_capacity_error',
        message: RAW_CANARY,
        raw: RAW_CANARY,
      },
    ]) {
      assert.deepEqual(
        classifyTaskProvisioningDiagnosticPrimaryFailure(
          error,
          'runtime_setup',
        ),
        {
          ...BASE_FAILURE,
          stage: 'sandbox_creation',
          operation: 'sandbox_create',
          outcome: 'failed',
          cause: 'capacity_exhausted',
        },
      );
    }
  });

  it('classifies provider configuration, capability, and selection failures as unavailable', () => {
    const errors = [
      new SandboxProviderConfigurationError(RAW_CANARY),
      new SandboxProviderCapabilityError(RAW_CANARY, [RAW_CANARY]),
      new SandboxProviderSelectionError(RAW_CANARY),
      { code: 'sandbox_provider_configuration_error', message: RAW_CANARY },
      { code: 'sandbox_provider_capability_error', cause: RAW_CANARY },
      { code: 'sandbox_provider_selection_error', stack: RAW_CANARY },
    ];

    for (const error of errors) {
      assert.deepEqual(
        classifyTaskProvisioningDiagnosticPrimaryFailure(
          error,
          'workspace_transfer',
        ),
        {
          ...BASE_FAILURE,
          stage: 'provider_selection',
          operation: 'provider_select',
          outcome: 'failed',
          cause: 'provider_unavailable',
        },
      );
    }
  });

  it('classifies typed runtime setup and readiness stages without provider prose', () => {
    assert.deepEqual(
      classifyTaskProvisioningDiagnosticPrimaryFailure(
        new SandboxProvisioningStageError('runtime_setup'),
        'sandbox_creation',
      ),
      {
        ...BASE_FAILURE,
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        commandKind: 'runtime_setup',
        outcome: 'failed',
        cause: 'command_failed',
      },
    );
    assert.deepEqual(
      classifyTaskProvisioningDiagnosticPrimaryFailure(
        new SandboxProvisioningStageError('readiness'),
        'sandbox_creation',
      ),
      {
        ...BASE_FAILURE,
        stage: 'readiness',
        operation: 'runtime_preflight',
        commandKind: 'runtime_preflight',
        outcome: 'failed',
        cause: 'unknown',
      },
    );
  });

  it('keeps provider selection distinct from other runtime-model setup phases', () => {
    const setupPhases: readonly RuntimeModelSetupFailurePhase[] = [
      'lookup',
      'snapshot',
      'runtime-resolution',
      'launch-context',
      'material-write',
      'material-verify',
    ];
    for (const phase of setupPhases) {
      assert.deepEqual(
        classifyTaskProvisioningDiagnosticPrimaryFailure(
          new SandboxRuntimeModelSetupError(phase),
          'sandbox_creation',
        ),
        {
          ...BASE_FAILURE,
          stage: 'runtime_setup',
          operation: 'runtime_setup',
          commandKind: 'runtime_setup',
          outcome: 'failed',
          cause: 'command_failed',
        },
      );
    }

    for (const error of [
      new SandboxRuntimeModelSetupError('provider-selection'),
      {
        code: 'runtime_model_setup_failed',
        phase: 'provider-selection',
        message: RAW_CANARY,
      },
    ]) {
      assert.deepEqual(
        classifyTaskProvisioningDiagnosticPrimaryFailure(
          error,
          'sandbox_creation',
        ),
        {
          ...BASE_FAILURE,
          stage: 'provider_selection',
          operation: 'provider_select',
          outcome: 'failed',
          cause: 'provider_unavailable',
        },
      );
    }
  });

  it('reduces unknown raw values to the canonical fallback without leaking canaries', () => {
    const raw = {
      message: RAW_CANARY,
      cause: { body: RAW_CANARY },
      stack: RAW_CANARY,
      raw: Buffer.from(RAW_CANARY),
      command: RAW_CANARY,
    };
    const classified = classifyTaskProvisioningDiagnosticPrimaryFailure(
      raw,
      'credential_cleanup',
    );

    assert.deepEqual(classified, {
      ...BASE_FAILURE,
      stage: 'credential_cleanup',
      operation: 'credential_cleanup',
      commandKind: 'credential_cleanup',
      outcome: 'failed',
      cause: 'unknown',
    });
    assert.equal(JSON.stringify(classified).includes(RAW_CANARY), false);
    assert.deepEqual(Object.keys(classified), [
      'state',
      'stage',
      'operation',
      'commandKind',
      'outcome',
      'cause',
      'retryable',
      'exitCode',
    ]);
  });

  it('treats a throwing structural accessor as unknown non-authoritative evidence', () => {
    const raw = Object.defineProperty({}, 'code', {
      get() {
        throw new Error(RAW_CANARY);
      },
    });
    assert.deepEqual(
      classifyTaskProvisioningDiagnosticPrimaryFailure(raw, 'sandbox_start'),
      {
        ...BASE_FAILURE,
        stage: 'sandbox_start',
        operation: 'sandbox_start',
        outcome: 'failed',
        cause: 'unknown',
      },
    );
  });

  it('returns a frozen value that cannot be rewritten after classification', () => {
    const classified = classifyTaskProvisioningDiagnosticPrimaryFailure(
      new Error(RAW_CANARY),
      'readiness',
    );
    assert.equal(Object.isFrozen(classified), true);
    assert.throws(
      () => Object.defineProperty(classified, 'cause', { value: RAW_CANARY }),
      TypeError,
    );
    assert.equal(classified.cause, 'unknown');
    assert.equal(JSON.stringify(classified).includes(RAW_CANARY), false);
  });
});
