const MAX_RECORDED_CALLS = 200;

/**
 * Test-only sandbox provider used by the live scheduled-task browser story.
 *
 * It deliberately rejects provisioning after recording the outermost provider
 * invocation. This keeps the real TasksService and GuardrailsService admission
 * path in play without requiring Docker, model credentials, or a live agent.
 * Clone/auth material is intentionally never retained in the evidence ledger.
 */
export class RecordingSandboxProvider {
  #calls = [];
  #sequence = 0;

  getSandboxMode() {
    return 'workspace-write';
  }

  getProviderCapabilities() {
    return [
      'terminal.websocket',
      'workspace.git.materialize',
      'workspace.git.deliver',
      'transcript.retained-read',
      'lifecycle.readopt',
    ];
  }

  async provision(context) {
    this.#record('provision', context.taskId, 'rejected');
    throw new Error('scheduled-task-live-e2e: deterministic provision rejection');
  }

  async teardownSandbox(taskId) {
    this.#record('teardownSandbox', taskId, 'completed');
  }

  async readRolloutFromContainer(taskId) {
    this.#record('readRolloutFromContainer', taskId, 'empty');
    return null;
  }

  async sandboxExists(taskId) {
    this.#record('sandboxExists', taskId, 'false');
    return false;
  }

  async deliverWorkspaceChanges(taskId) {
    this.#record('deliverWorkspaceChanges', taskId, 'no-changes');
    return { hadChanges: false, commitSha: null, error: null };
  }

  async getSelectedSandboxRun(taskId) {
    this.#record('getSelectedSandboxRun', taskId, 'empty');
    return null;
  }

  evidence({ taskId, taskIds } = {}) {
    const allowedTaskIds = taskIds ? new Set(taskIds) : null;
    return this.#calls.filter((call) => {
      if (taskId && call.taskId !== taskId) return false;
      return !allowedTaskIds || allowedTaskIds.has(call.taskId);
    });
  }

  #record(operation, taskId, outcome) {
    this.#sequence += 1;
    this.#calls.push({
      sequence: this.#sequence,
      operation,
      taskId,
      time: new Date().toISOString(),
      outcome,
    });
    if (this.#calls.length > MAX_RECORDED_CALLS) {
      this.#calls.splice(0, this.#calls.length - MAX_RECORDED_CALLS);
    }
  }
}
