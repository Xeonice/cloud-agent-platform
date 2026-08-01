/**
 * The inline admission pipeline: provision a sandbox and start the agent run
 * synchronously, inside the request that accepted the task.
 *
 * This is the path a deployment takes when it cannot prove the
 * `task-admission-v2` capability. Its durable counterpart writes a work row and
 * lets a worker drive provisioning out of band, which survives a restart; this
 * one holds everything in process memory, which does not. That is the whole
 * difference, and it is why this pipeline is expected to be retired.
 *
 * It is a DIRECTORY on purpose. Everything inline admission owns lives here, so
 * retiring it is `rm -rf` this directory plus whatever the compiler then reports
 * at the handful of call sites in `guardrails`. Before this file existed the same
 * question — "what is inline admission, exactly?" — could only be answered by
 * reading a 4,500-line class and trusting a naming convention that did not cover
 * the 350-line block doing most of the work.
 *
 * The dependency runs one way. This directory declares what it needs from the
 * orchestrator in {@link InlineAdmissionOrchestratorPort} and never imports from
 * `guardrails`, so `scripts/api-module-layout-check.mjs` sees an acyclic edge and
 * this directory can be moved or deleted without touching its consumer's imports.
 *
 * Behaviour is byte-for-byte what it was inside `GuardrailsService`. The 122
 * guardrails tests were not edited to accommodate the move; had any of them
 * needed editing, the move would have been wrong.
 */

import type {
  TaskProvisioningDiagnosticProviderFamily,
  TaskProvisioningDiagnosticStage,
  TaskStatus,
} from '@cap-console/contracts';
import {
  selectSandboxProvider,
  snapshotSandboxProvisionContext,
  type SandboxProvisioningDiagnosticEmitter,
  type SandboxProvisioningDiagnosticFact,
  type AgentTerminalLaunchOutcome,
} from '@cap-console/sandbox';
import type { AdmissionTransitionResult } from '@/task-operations/task-operations.port';
import type { PrismaService } from '@/prisma/prisma.service';
import type {
  SandboxConnection,
  SandboxProvider,
} from '@/sandbox/sandbox-provider.port';
import {
  classifyTaskProvisioningDiagnosticPrimaryFailure,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-primary.classifier';
import type {
  BegunTaskProvisioningDiagnosticObserver,
  TaskProvisioningDiagnosticPrimarySettlementInput,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-observer.adapter';
import type { TaskProvisioningDiagnosticRecorderPort } from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsWriteGatePort } from '@/task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import { InlineAdmissionState } from './inline-admission-state';
import type { InlineAdmissionPort } from './inline-admission.entry';
import type { InlineAdmissionOrchestratorPort } from './inline-admission.port';

export class InlineAdmissionPipeline implements InlineAdmissionPort {
  constructor(
    private readonly orchestrator: InlineAdmissionOrchestratorPort,
    private readonly sandbox?: SandboxProvider,
    private readonly prisma?: PrismaService,
    private readonly provisioningDiagnosticRecorder?: TaskProvisioningDiagnosticRecorderPort,
    private readonly provisioningDiagnosticWriteGate?: TaskProvisioningDiagnosticsWriteGatePort,
  ) {}

  /**
   * Owned outright rather than injected: the orchestrator has no legitimate use
   * for this state, and handing it in would make it reachable from a place that
   * must not be able to mutate it.
   */
  private readonly state = new InlineAdmissionState();

  // ---------------------------------------------------------------------------
  // Entry surface.
  //
  // Every way the guardrails orchestrator still touches inline admission, named
  // in one place. This list IS the removal checklist: when this pipeline is
  // retired, these are the calls the compiler will report, and there are no
  // others because the state behind them is not reachable any other way.
  // ---------------------------------------------------------------------------

  /** The terminal fence aborts an in-flight provider call synchronously. */
  abortProvisioning(taskId: string): void {
    this.abortLegacyProvisioning(taskId);
  }

  /** Recover this task's retained diagnostic attempt for terminal settlement. */
  resolveTerminalDiagnosticAttempt(
    taskId: string,
  ): Promise<BegunTaskProvisioningDiagnosticObserver | undefined> {
    return this.resolveLegacyTerminalDiagnosticAttempt(taskId);
  }

  /** Whether a provider boundary was crossed and so cleanup must be observed. */
  providerBoundaryCrossed(taskId: string): boolean {
    return this.state.providerBoundariesCrossed.has(taskId);
  }

  /** Whether the primary settlement already owns `not_required` for cleanup. */
  cleanupNotRequired(taskId: string): boolean {
    return this.state.cleanupNotRequired.has(taskId);
  }

  markCleanupNotRequired(taskId: string): void {
    this.state.cleanupNotRequired.add(taskId);
  }

  /**
   * Settle the retained attempt against a terminal transition this pipeline did
   * not win. The cancellation error is supplied here rather than by the caller:
   * it was always the same value, and leaving it at the call site kept a
   * pipeline-internal detail in the orchestrator's vocabulary.
   */
  settleTerminalPrimary(
    taskId: string,
    diagnosticAttempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    status: TaskStatus | undefined,
    providerBoundaryCrossed: boolean,
  ): Promise<void> {
    return this.settleLegacyTerminalPrimary(
      taskId,
      diagnosticAttempt,
      status,
      createLegacyProvisioningCancellationError(),
      providerBoundaryCrossed,
    );
  }

  /** Settle an attempt superseded before or during provisioning. */
  settleProvisioningSupersession(
    taskId: string,
    diagnosticAttempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    error?: unknown,
    providerBoundaryCrossed = true,
  ): Promise<void> {
    return this.settleLegacyProvisioningSupersession(
      taskId,
      diagnosticAttempt,
      error,
      providerBoundaryCrossed,
    );
  }

  /**
   * Retain a freshly begun attempt so natural terminal settlement can append
   * cleanup evidence to the same row. Position is seeded at provider selection
   * because that is the first fact this pipeline can honestly report.
   */
  rememberBegunAttempt(
    taskId: string,
    attempt: BegunTaskProvisioningDiagnosticObserver,
  ): void {
    this.state.diagnosticAttempts.set(taskId, attempt);
    this.state.diagnosticPositions.set(taskId, {
      stage: 'provider_selection',
      operation: 'provider_select',
    });
  }

  /** Drop everything retained for a task that has finished settling. */
  forget(taskId: string): void {
    this.state.forget(taskId);
  }

  /**
   * Provision the sandbox and start the run, synchronously, inside the accepting
   * request. Returns the same transition result the orchestrator would have
   * returned when this code was inlined in `startRunningAfterCapacity`.
   *
   * THE RUN-LEVEL SUPERSESSION EXIT (add-domain-event-bus 4.10). The provisioning
   * body below returns `superseded` from nine different early-return points, and
   * one run can pass several of them — the fence is re-checked before and after
   * every await. Publishing at each check would report a single supersession up
   * to nine times, so the body stays untouched and this one wrapper turns "this
   * run ended superseded" into exactly one event. Any other outcome publishes
   * nothing.
   */
  async run(
    taskId: string,
    transitionToken: string,
    diagnosticAttempt?: BegunTaskProvisioningDiagnosticObserver,
  ): Promise<AdmissionTransitionResult | 'failed'> {
    const outcome = await this.runProvisioning(
      taskId,
      transitionToken,
      diagnosticAttempt,
    );
    if (outcome === 'superseded') {
      this.orchestrator.publishRunSupersession(taskId, transitionToken);
    }
    return outcome;
  }

  private async runProvisioning(
    taskId: string,
    transitionToken: string,
    diagnosticAttempt?: BegunTaskProvisioningDiagnosticObserver,
  ): Promise<AdmissionTransitionResult | 'failed'> {
    const sandbox = this.sandbox;
    if (sandbox) {
      let provisionPlan;
      try {
        provisionPlan = await this.orchestrator.resolveProvisionPlan(taskId);
      } catch (err) {
        if (!(await this.orchestrator.waitForRunningAdmission(taskId, transitionToken))) {
          await this.settleLegacyProvisioningSupersession(
            taskId,
            diagnosticAttempt,
            err,
            false,
          );
          this.orchestrator.clearAdmissionRuntime(taskId);
          return 'superseded';
        }
        this.rememberLegacyProvisioningFailure(
          taskId,
          err,
          'provider_selection',
          false,
        );
        const winner = await this.orchestrator.failProvisioning(taskId, err);
        await this.settleLegacyProvisioningSupersession(
          taskId,
          diagnosticAttempt,
          err,
          false,
        );
        if (
          winner === 'failed' &&
          this.orchestrator.terminalStatusOf(taskId) === 'failed'
        ) {
          this.orchestrator.logger().error(
            `resolve sandbox requirements for task ${taskId} failed (provider details redacted)`,
          );
        }
        return this.finishLegacyProvisioningFailure(taskId, winner);
      }
      if (!(await this.orchestrator.waitForRunningAdmission(taskId, transitionToken))) {
        await this.settleLegacyProvisioningSupersession(
          taskId,
          diagnosticAttempt,
          undefined,
          false,
        );
        this.orchestrator.clearAdmissionRuntime(taskId);
        return 'superseded';
      }
      let selected;
      let selectionError: unknown;
      try {
        selected = selectSandboxProvider(
          sandbox,
          provisionPlan.requiredCapabilities,
        );
      } catch (error) {
        selectionError = error;
      }
      if (!(await this.orchestrator.waitForRunningAdmission(taskId, transitionToken))) {
        await this.settleLegacyProvisioningSupersession(
          taskId,
          diagnosticAttempt,
          selectionError,
          false,
        );
        this.orchestrator.clearAdmissionRuntime(taskId);
        return 'superseded';
      }
      if (this.orchestrator.isTerminallyFenced(taskId)) {
        await this.settleLegacyProvisioningSupersession(
          taskId,
          diagnosticAttempt,
          selectionError,
          false,
        );
        this.orchestrator.clearAdmissionRuntime(taskId);
        return 'superseded';
      }
      if (!selected) {
        const error = selectionError ?? new Error('Sandbox provider unavailable');
        this.rememberLegacyProviderUnavailable(taskId, false);
        const winner = await this.orchestrator.forceFail(taskId, 'provision_failed');
        await this.settleLegacyProvisioningSupersession(
          taskId,
          diagnosticAttempt,
          error,
          false,
        );
        if (
          winner === 'failed' &&
          this.orchestrator.terminalStatusOf(taskId) === 'failed'
        ) {
          this.orchestrator.logger().error(
            `select sandbox provider for task ${taskId} failed (provider details redacted)`,
          );
        }
        return this.finishLegacyProvisioningFailure(taskId, winner);
      }

      // The synchronous fence immediately precedes the provider invocation.
      // Legacy admission has no lease-owned signal, so retain one task-owned
      // controller for this provider call and combine it with any plan signal.
      // The persisted transition guard closes the same race across replicas.
      if (this.orchestrator.isTerminallyFenced(taskId)) {
        await this.settleLegacyProvisioningSupersession(
          taskId,
          diagnosticAttempt,
          undefined,
          false,
        );
        this.orchestrator.clearAdmissionRuntime(taskId);
        return 'superseded';
      }
      let connection: SandboxConnection | undefined;
      const provisioningCancellation = this.beginLegacyProvisioning(taskId);
      const providerCancellationSignal = combineCancellationSignals(
        provisionPlan.cancellationSignal,
        provisioningCancellation.signal,
      );
      try {
        // Resolved BEFORE the provider boundary is marked: a fail-closed
        // workspace-source error (copy not ready / unsupported provider) is a
        // provisioning failure that crossed no provider boundary.
        const workspaceSource = await this.orchestrator.resolveWorkspaceSource(
          taskId,
          provisionPlan,
          selected.capabilities,
        );
        this.state.providerBoundariesCrossed.add(taskId);
        connection = await selected.provider.provision(
          snapshotSandboxProvisionContext({
            taskId,
            ...(workspaceSource === undefined ? {} : { workspaceSource }),
            ...(diagnosticAttempt === undefined
              ? {}
              : {
                  diagnostics: this.observeLegacyProvisioningDiagnostics(
                    taskId,
                    diagnosticAttempt.diagnostics,
                  ),
                }),
            cloneSpec: provisionPlan.cloneSpec,
            modelIntent: provisionPlan.modelIntent,
            runtimeId: provisionPlan.runtimeId,
            executionMode: provisionPlan.executionMode,
            environment: provisionPlan.environment,
            resources: provisionPlan.resources,
            workspace: provisionPlan.workspace,
            cancellationSignal: providerCancellationSignal,
            externalBoundaryGuard: async () => {
              if (
                await this.orchestrator.waitForRunningAdmission(
                  taskId,
                  transitionToken,
                  providerCancellationSignal,
                )
              ) {
                return;
              }
              if (!provisioningCancellation.signal.aborted) {
                provisioningCancellation.abort(
                  createLegacyProvisioningCancellationError(),
                );
              }
              throw (
                provisioningCancellation.signal.reason ??
                createLegacyProvisioningCancellationError()
              );
            },
            // detach-workspace-clone D11: the legacy chain is kept (it still
            // has live callers) but routed through the same shared workspace
            // progress chain as durable admission, so additive progress
            // variants can never drift between the two chains. Legacy has no
            // durable lease, so no checkpoint hook is supplied — and for the
            // same reason it deliberately passes NO workspaceTransferDetachment:
            // without a parked settlement/lease to hand the claim to, the
            // legacy chain explicitly and consistently keeps the inline
            // (blocking) await of the detached transfer, which still runs as
            // a detached job under dual-gate liveness — never the old
            // single-deadline blocking exec, and never a half-parked state.
            onWorkspaceProgress: this.orchestrator.buildWorkspaceProgressChain({
              forward: provisionPlan.onWorkspaceProgress,
            }),
          }),
        );
      } catch (err) {
        if (!(await this.orchestrator.waitForRunningAdmission(taskId, transitionToken))) {
          await this.settleLegacyProvisioningSupersession(
            taskId,
            diagnosticAttempt,
            err,
          );
          this.orchestrator.clearAdmissionRuntime(taskId);
          return 'superseded';
        }
        this.rememberLegacyProvisioningFailure(
          taskId,
          err,
          'sandbox_creation',
          true,
        );
        const winner = await this.orchestrator.failProvisioning(taskId, err);
        await this.settleLegacyProvisioningSupersession(
          taskId,
          diagnosticAttempt,
          err,
          true,
        );
        if (
          winner === 'failed' &&
          this.orchestrator.terminalStatusOf(taskId) === 'failed'
        ) {
          this.orchestrator.logger().error(
            `provision sandbox for task ${taskId} failed (provider details redacted)`,
          );
        }
        return this.finishLegacyProvisioningFailure(taskId, winner);
      } finally {
        this.releaseLegacyProvisioning(taskId, provisioningCancellation);
      }
      if (!(await this.orchestrator.waitForRunningAdmission(taskId, transitionToken))) {
        await this.settleLegacyProvisioningSupersession(
          taskId,
          diagnosticAttempt,
          createLegacyProvisioningCancellationError(),
          true,
        );
        await selected.provider.teardownSandbox(taskId, {
          disposition: 'superseded-remove',
        }).catch(() => {
          this.orchestrator.logger().warn(
            `discarding superseded sandbox for task ${taskId} failed (provider details redacted)`,
          );
        });
        this.orchestrator.clearAdmissionRuntime(taskId);
        return 'superseded';
      }
      if (connection) {
        this.orchestrator.registerConnection(taskId, connection);
        const selectedRun = await this.orchestrator.resolveSelectedRun(taskId);
        if (!(await this.orchestrator.waitForRunningAdmission(taskId, transitionToken))) {
          await this.settleLegacyProvisioningSupersession(
            taskId,
            diagnosticAttempt,
            undefined,
            true,
          );
          await selected.provider.teardownSandbox(taskId, {
            disposition: 'superseded-remove',
          }).catch(() => {
            this.orchestrator.logger().warn(
              `discarding superseded sandbox for task ${taskId} failed (provider details redacted)`,
            );
          });
          this.orchestrator.clearAdmissionRuntime(taskId);
          return 'superseded';
        }
        if (this.orchestrator.isTerminallyFenced(taskId)) {
          await this.settleLegacyProvisioningSupersession(
            taskId,
            diagnosticAttempt,
            undefined,
            true,
          );
          await selected.provider.teardownSandbox(taskId, {
            disposition: 'superseded-remove',
          }).catch(() => {
            this.orchestrator.logger().warn(
              `discarding terminal sandbox for task ${taskId} failed (provider details redacted)`,
            );
          });
          this.orchestrator.clearAdmissionRuntime(taskId);
          return 'superseded';
        }
        // Legacy `SandboxProvisioned` (add-domain-event-bus 4.9), 2 of the 2
        // provisioning paths. Deliberately BELOW both post-provision fence
        // checks above: each of those discards the sandbox it just created, and
        // an attempt whose sandbox is torn down as superseded or terminal
        // provisioned nothing anybody may observe. Publishing next to
        // `registerConnection` would have been the obvious placement and would
        // have announced sandboxes that no longer exist.
        //
        // Both arguments are values this seam already holds — the connection it
        // registered and the selected run it already read. No new lookup.
        this.orchestrator.publishSandboxProvisioned({
          taskId,
          connection,
          selectedRun,
          plan: provisionPlan,
        });
        // 4.2 — hand the handle through to the terminal gateway so it dials the
        // sandbox terminal OUT and registers the session (replacing the previous
        // dial-back-registers-the-session flow). Idempotent on the gateway side;
        // best-effort so a terminal wiring hiccup never fails the lifecycle.
        if (this.orchestrator.hasTerminalGateway()) {
          try {
            this.state.diagnosticPositions.set(taskId, {
              stage: 'agent_launch',
              operation: 'agent_launch',
              commandKind: 'agent_launch',
            });
            const session = this.orchestrator.openTerminalSession(
              connection,
              selectedRun,
            );
            this.observeLegacyAgentLaunchDiagnostics(
              taskId,
              transitionToken,
              diagnosticAttempt,
              session.launchDecision,
            );
          } catch {
            this.orchestrator.logger().error(
              `opening terminal session for task ${taskId} failed (provider details redacted)`,
            );
            await this.orchestrator.settleProvisioningDiagnostics(diagnosticAttempt, {
              state: 'failed',
              stage: 'agent_launch',
              operation: 'agent_launch',
              commandKind: 'agent_launch',
              outcome: 'failed',
              cause: 'unknown',
              retryable: false,
              exitCode: null,
              completion: 'leave_partial',
            });
          }
        } else {
          await this.orchestrator.settleProvisioningDiagnostics(diagnosticAttempt, {
            state: 'failed',
            stage: 'agent_launch',
            operation: 'agent_launch',
            commandKind: 'agent_launch',
            outcome: 'failed',
            cause: 'provider_unavailable',
            retryable: false,
            exitCode: null,
            completion: 'leave_partial',
          });
        }
      } else {
        // provision REJECTED (or returned no handle): the provider already tore
        // down any partially-started container (its own try/catch). Reclaim NOW
        // instead of waiting for the idle ceiling — forceFail transitions the
        // task to `failed`, clears its timers, tears down the session, and
        // RELEASES the run slot (admitting the next queued task). Without this
        // the slot stays held until idle-timeout, starving the queue whenever a
        // provision fails (e.g. codex auth / clone fail-closed).
        const error = new Error('Sandbox provider returned no connection');
        this.rememberLegacyProvisioningFailure(
          taskId,
          error,
          'sandbox_creation',
          true,
        );
        const winner = await this.orchestrator.forceFail(taskId, 'provision_failed');
        await this.settleLegacyProvisioningSupersession(
          taskId,
          diagnosticAttempt,
          error,
          true,
        );
        return this.finishLegacyProvisioningFailure(taskId, winner);
      }
    } else {
      const error = new Error('Sandbox provider unavailable');
      this.rememberLegacyProviderUnavailable(taskId, false);
      const winner = await this.orchestrator.forceFail(taskId, 'provision_failed');
      await this.settleLegacyProvisioningSupersession(
        taskId,
        diagnosticAttempt,
        error,
        false,
      );
      return this.finishLegacyProvisioningFailure(taskId, winner);
    }
    return 'transitioned';
  }

  /**
   * Legacy admission returns after session registration, but the terminal's
   * non-rejecting launch decision is the actual agent-launch proof. Observe it
   * out of band so request completion/disconnect never owns diagnostic lifetime.
   */
  private observeLegacyAgentLaunchDiagnostics(
    taskId: string,
    transitionToken: string,
    attempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    launchDecision: Promise<AgentTerminalLaunchOutcome>,
  ): void {
    void launchDecision
      .then(async (decision) => {
        if (!(await this.orchestrator.waitForRunningAdmission(taskId, transitionToken))) {
          await this.settleLegacyProvisioningSupersession(
            taskId,
            attempt,
            undefined,
            true,
          );
          return;
        }
        if (decision.kind === 'fenced') return;
        if (decision.kind === 'launched' || decision.kind === 'attached') {
          await this.orchestrator.settleProvisioningDiagnostics(attempt, {
            state: 'succeeded',
            stage: 'agent_launch',
            operation: 'agent_launch',
            commandKind: 'agent_launch',
            outcome: 'succeeded',
            cause: null,
            retryable: false,
            exitCode: null,
            completion: 'leave_partial',
          });
          return;
        }
        await this.orchestrator.settleProvisioningDiagnostics(attempt, {
          state: 'failed',
          stage: 'agent_launch',
          operation: 'agent_launch',
          commandKind: 'agent_launch',
          outcome:
            decision.kind === 'indeterminate' ? 'indeterminate' : 'failed',
          cause: 'unknown',
          retryable: false,
          exitCode: null,
          completion: 'leave_partial',
        });
      })
      .catch(async (error: unknown) => {
        if (!(await this.orchestrator.waitForRunningAdmission(taskId, transitionToken))) {
          await this.settleLegacyProvisioningSupersession(
            taskId,
            attempt,
            error,
            true,
          );
          return;
        }
        await this.orchestrator.settleProvisioningDiagnostics(attempt, {
          ...classifyTaskProvisioningDiagnosticPrimaryFailure(
            error,
            'agent_launch',
          ),
          completion: 'leave_partial',
        });
      });
  }

  /**
   * Legacy cleanup has no durable SandboxRun recovery authority, but its
   * diagnostic attempt is still durable evidence. Prefer the process-local
   * controller and, after a process restart, resume only the exact latest
   * legacy attempt number already allocated by the recorder.
   */
  private async resolveLegacyTerminalDiagnosticAttempt(
    taskId: string,
  ): Promise<BegunTaskProvisioningDiagnosticObserver | undefined> {
    const existing = this.state.diagnosticAttempts.get(taskId);
    if (existing) return existing;
    if (
      !this.prisma ||
      !this.provisioningDiagnosticRecorder ||
      !this.provisioningDiagnosticWriteGate
    ) {
      return undefined;
    }
    try {
      if (!this.provisioningDiagnosticWriteGate.isEnabled()) return undefined;
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: {
          provisioningDiagnosticSchemaVersion: true,
          provisioningDiagnosticNextAttempt: true,
        },
      });
      if (
        task?.provisioningDiagnosticSchemaVersion === null ||
        task?.provisioningDiagnosticSchemaVersion === undefined ||
        task.provisioningDiagnosticNextAttempt === null ||
        task.provisioningDiagnosticNextAttempt <= 1
      ) {
        return undefined;
      }
      const resumed = await this.orchestrator.tryResumeProvisioningDiagnostics({
        taskId,
        admissionMode: 'legacy',
        attempt: task.provisioningDiagnosticNextAttempt - 1,
      });
      if (resumed) this.state.diagnosticAttempts.set(taskId, resumed);
      return resumed;
    } catch {
      return undefined;
    }
  }

  private beginLegacyProvisioning(taskId: string): AbortController {
    this.abortLegacyProvisioning(taskId);
    const controller = new AbortController();
    this.state.provisioningAbortControllers.set(taskId, controller);
    return controller;
  }

  private abortLegacyProvisioning(taskId: string): void {
    const controller = this.state.provisioningAbortControllers.get(taskId);
    if (!controller) return;
    this.state.provisioningAbortControllers.delete(taskId);
    if (!controller.signal.aborted) {
      controller.abort(createLegacyProvisioningCancellationError());
    }
  }

  private releaseLegacyProvisioning(
    taskId: string,
    controller: AbortController,
  ): void {
    if (this.state.provisioningAbortControllers.get(taskId) === controller) {
      this.state.provisioningAbortControllers.delete(taskId);
    }
  }

  private observeLegacyProvisioningDiagnostics(
    taskId: string,
    diagnostics: SandboxProvisioningDiagnosticEmitter,
  ): SandboxProvisioningDiagnosticEmitter {
    return Object.freeze({
      mode: 'task' as const,
      get attemptContext() {
        return diagnostics.attemptContext;
      },
      createOperationId(replayKey?: Parameters<typeof diagnostics.createOperationId>[0]) {
        return diagnostics.createOperationId(replayKey);
      },
      emit: async (fact: SandboxProvisioningDiagnosticFact): Promise<void> => {
        await diagnostics.emit(fact);
        this.state.diagnosticPositions.set(taskId, {
          stage: fact.stage,
          operation: fact.operation,
          ...(fact.commandKind === undefined
            ? {}
            : { commandKind: fact.commandKind }),
        });
      },
      flush(): Promise<void> {
        return diagnostics.flush();
      },
      bindProviderFamily(
        providerFamily: TaskProvisioningDiagnosticProviderFamily,
      ) {
        diagnostics.bindProviderFamily(providerFamily);
      },
    });
  }

  private rememberLegacyProvisioningFailure(
    taskId: string,
    error: unknown,
    fallbackStage: TaskProvisioningDiagnosticStage,
    providerBoundaryCrossed: boolean,
  ): void {
    this.state.provisioningFailureCandidates.set(taskId, {
      settlement: {
        ...classifyTaskProvisioningDiagnosticPrimaryFailure(
          error,
          fallbackStage,
        ),
        completion: providerBoundaryCrossed
          ? 'leave_partial'
          : 'mark_if_complete',
      },
      providerBoundaryCrossed,
    });
  }

  private rememberLegacyProviderUnavailable(
    taskId: string,
    providerBoundaryCrossed: boolean,
  ): void {
    this.state.provisioningFailureCandidates.set(taskId, {
      settlement: {
        state: 'failed',
        stage: 'provider_selection',
        operation: 'provider_select',
        outcome: 'failed',
        cause: 'provider_unavailable',
        retryable: false,
        exitCode: null,
        completion: providerBoundaryCrossed
          ? 'leave_partial'
          : 'mark_if_complete',
      },
      providerBoundaryCrossed,
    });
  }

  private cancellationSettlementForLegacyAttempt(
    taskId: string,
    error: unknown,
    providerBoundaryCrossed: boolean,
    completion: 'mark_if_complete' | 'leave_partial',
  ): TaskProvisioningDiagnosticPrimarySettlementInput {
    const classified = classifyTaskProvisioningDiagnosticPrimaryFailure(
      error,
      providerBoundaryCrossed
        ? 'sandbox_creation'
        : 'provider_selection',
    );
    const position = this.state.diagnosticPositions.get(taskId);
    return {
      ...classified,
      ...(position === undefined
        ? {}
        : {
            stage: position.stage,
            operation: position.operation,
            ...(position.commandKind === undefined
              ? { commandKind: null }
              : { commandKind: position.commandKind }),
          }),
      state: 'cancelled',
      outcome: 'cancelled',
      cause: 'cancelled',
      retryable: false,
      exitCode: null,
      completion,
    };
  }

  private async settleLegacyTerminalPrimary(
    taskId: string,
    diagnosticAttempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    status: TaskStatus | undefined,
    error: unknown,
    providerBoundaryCrossed: boolean,
  ): Promise<void> {
    if (!diagnosticAttempt) return;
    const candidate = this.state.provisioningFailureCandidates.get(taskId);
    if (
      status === 'failed' &&
      candidate &&
      this.orchestrator.terminalStatusOf(taskId) === 'failed'
    ) {
      await this.orchestrator.settleProvisioningDiagnostics(
        diagnosticAttempt,
        candidate.settlement,
      );
      return;
    }
    if (status === 'cancelled') {
      await this.orchestrator.settleProvisioningDiagnostics(
        diagnosticAttempt,
        this.cancellationSettlementForLegacyAttempt(
          taskId,
          error,
          providerBoundaryCrossed,
          providerBoundaryCrossed ? 'leave_partial' : 'mark_if_complete',
        ),
      );
      return;
    }

    const position = this.state.diagnosticPositions.get(taskId);
    const classified = classifyTaskProvisioningDiagnosticPrimaryFailure(
      error,
      providerBoundaryCrossed
        ? 'sandbox_creation'
        : 'provider_selection',
    );
    await this.orchestrator.settleProvisioningDiagnostics(diagnosticAttempt, {
      ...classified,
      ...(position === undefined
        ? {}
        : {
            stage: position.stage,
            operation: position.operation,
            ...(position.commandKind === undefined
              ? { commandKind: null }
              : { commandKind: position.commandKind }),
          }),
      state: 'interrupted',
      outcome: 'indeterminate',
      cause: 'settlement_unknown',
      retryable: true,
      exitCode: null,
      completion: providerBoundaryCrossed
        ? 'leave_partial'
        : 'mark_if_complete',
    });
  }

  private async settleLegacyProvisioningSupersession(
    taskId: string,
    diagnosticAttempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    error: unknown = createLegacyProvisioningCancellationError(),
    providerBoundaryCrossed = true,
  ): Promise<void> {
    await this.settleLegacyTerminalPrimary(
      taskId,
      diagnosticAttempt,
      await this.orchestrator.terminalTaskStatus(taskId),
      error,
      providerBoundaryCrossed,
    );
    if (!providerBoundaryCrossed || !diagnosticAttempt) return;
    const getCleanupAuthority = this.sandbox?.getSandboxCleanupAuthority;
    if (!getCleanupAuthority) return;
    try {
      const authority = await getCleanupAuthority.call(this.sandbox, taskId);
      if (authority.status === null) return;
      // A provider continuation may be the only replica that can close its
      // entered create fence. Once that continuation has durably converged the
      // cleanup, advance the same task attempt from the terminal replica's
      // pending evidence. A still-pending attempt is retained too: it carries
      // exact failed/indeterminate evidence without manufacturing completeness.
      await this.orchestrator.settleCleanupDiagnostics(
        diagnosticAttempt.settlement,
        authority,
      );
    } catch {
      // Cleanup authority remains owned by the persistent fence. An uncertain
      // read cannot manufacture terminal cleanup or diagnostic completeness.
    }
  }

  /**
   * TasksService returns the already-committed row when another replica wins
   * the same `failed` transition. With no local terminal callback, that replica
   * owns audit and physical settlement; this process must retire only its local
   * timers/session mirror and report supersession so admitUntracked releases its
   * exact semaphore reservation.
   */
  private finishLegacyProvisioningFailure(
    taskId: string,
    winner: TaskStatus | undefined,
  ): 'transitioned' | 'superseded' {
    if (
      winner !== 'failed' ||
      this.orchestrator.terminalStatusOf(taskId) === 'failed'
    ) {
      return 'transitioned';
    }
    this.orchestrator.clearAdmissionRuntime(taskId);
    return 'superseded';
  }}

/**
 * Moved verbatim from `GuardrailsService`. The error name matters: `AbortError`
 * is what the provider-side guards and the diagnostic classifier match on to tell
 * a cancellation apart from a genuine provisioning failure.
 */
function combineCancellationSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const defined = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

export function createLegacyProvisioningCancellationError(): Error {
  const error = new Error('Legacy sandbox provisioning was cancelled');
  error.name = 'AbortError';
  return error;
}
