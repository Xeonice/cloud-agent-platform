/**
 * Domain event publishing from the inline admission pipeline (add-domain-event-bus 4.12).
 *
 * The pipeline reaches the bus through its orchestrator port rather than holding
 * one, so these tests drive the pipeline against a recording orchestrator. That
 * is the point of the port: what the pipeline publishes is observable without
 * standing up a `GuardrailsService`.
 *
 * The property this file exists for is the one no end-to-end test states clearly:
 * a single run can pass SEVERAL internal supersession checks, and must still
 * report exactly ONE supersession. Publishing per check — the obvious wiring —
 * would report one lost race up to nine times.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SandboxProvider } from '@/sandbox/sandbox-provider.port';
import type { SandboxProvisionContext } from '@cap-console/sandbox';
import { InlineAdmissionPipeline } from './inline-admission.pipeline';
import type { InlineAdmissionOrchestratorPort } from './inline-admission.port';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const TRANSITION_TOKEN = '55555555-5555-4555-8555-555555555555';

type Published =
  | { readonly kind: 'sandbox.provisioned'; readonly taskId: string }
  | {
      readonly kind: 'task.superseded';
      readonly taskId: string;
      readonly fenceToken: string;
    };

/**
 * The orchestrator, recorded.
 *
 * `fenceCurrent` decides how many times `waitForRunningAdmission` reports the
 * attempt still owns its transition; every call after that reports a lost fence,
 * which is how a run is walked into its supersession exits.
 */
function recordingOrchestrator(options: {
  fenceCurrentFor?: number;
  terminallyFenced?: boolean;
  /** What the orchestrator's fence recorded, which decides whether a forced
   *  failure was THIS attempt's own (transitioned) or someone else's
   *  (superseded). */
  terminalStatus?: 'failed';
} = {}) {
  const published: Published[] = [];
  let fenceChecks = 0;
  const orchestrator: InlineAdmissionOrchestratorPort = {
    logger: () => ({ warn() {}, error() {} }),
    clearAdmissionRuntime() {},
    async waitForRunningAdmission() {
      fenceChecks += 1;
      return fenceChecks <= (options.fenceCurrentFor ?? Number.MAX_SAFE_INTEGER);
    },
    async settleProvisioningDiagnostics() {},
    async settleCleanupDiagnostics() {},
    async tryResumeProvisioningDiagnostics() {
      return undefined;
    },
    async forceFail() {
      return 'failed';
    },
    async failProvisioning() {
      return 'failed';
    },
    async terminalTaskStatus() {
      return undefined;
    },
    isTerminallyFenced: () => options.terminallyFenced === true,
    terminalStatusOf: () => options.terminalStatus,
    async resolveProvisionPlan() {
      return {
        taskId: TASK_ID,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
        requiredCapabilities: [],
        cloneSpec: null,
      } as unknown as Awaited<
        ReturnType<InlineAdmissionOrchestratorPort['resolveProvisionPlan']>
      >;
    },
    async resolveWorkspaceSource() {
      return undefined;
    },
    async resolveSelectedRun() {
      return null;
    },
    buildWorkspaceProgressChain: () => () => {},
    registerConnection() {},
    publishSandboxProvisioned(source) {
      published.push({ kind: 'sandbox.provisioned', taskId: source.taskId });
    },
    publishRunSupersession(taskId, fenceToken) {
      published.push({ kind: 'task.superseded', taskId, fenceToken });
    },
    hasTerminalGateway: () => false,
    openTerminalSession() {
      throw new Error('no terminal gateway in this fixture');
    },
  };
  return {
    orchestrator,
    published,
    of: (kind: Published['kind']) =>
      published.filter((event) => event.kind === kind),
    fenceChecksMade: () => fenceChecks,
  };
}

function provisioningSandbox(): SandboxProvider {
  return {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      return {
        taskId: context.taskId,
        baseUrl: 'http://127.0.0.1:8080',
        wsUrl: 'ws://127.0.0.1:8080/ws',
      };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
}

test('a successful run publishes one SandboxProvisioned and no supersession', async () => {
  const recorder = recordingOrchestrator();
  const pipeline = new InlineAdmissionPipeline(
    recorder.orchestrator,
    provisioningSandbox(),
  );

  await pipeline.run(TASK_ID, TRANSITION_TOKEN);

  assert.equal(recorder.of('sandbox.provisioned').length, 1);
  assert.equal(recorder.of('task.superseded').length, 0);
});

test('one run that passes several supersession checks publishes exactly one TaskSuperseded', async () => {
  // The fence holds for the first two checks and is lost afterwards, so the run
  // travels past more than one supersession boundary before it exits.
  const recorder = recordingOrchestrator({ fenceCurrentFor: 2 });
  const pipeline = new InlineAdmissionPipeline(
    recorder.orchestrator,
    provisioningSandbox(),
  );

  const outcome = await pipeline.run(TASK_ID, TRANSITION_TOKEN);

  assert.equal(outcome, 'superseded');
  assert(
    recorder.fenceChecksMade() > 2,
    'the run must have passed more than one fence check to prove aggregation',
  );
  const superseded = recorder.of('task.superseded');
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0]?.taskId, TASK_ID);
  // The losing side's own token — the only fence identity this observer holds.
  assert.deepEqual(
    superseded.map((event) =>
      event.kind === 'task.superseded' ? event.fenceToken : undefined,
    ),
    [TRANSITION_TOKEN],
  );
});

test('a run superseded before the provider boundary publishes no SandboxProvisioned', async () => {
  const recorder = recordingOrchestrator({ fenceCurrentFor: 0 });
  const pipeline = new InlineAdmissionPipeline(
    recorder.orchestrator,
    provisioningSandbox(),
  );

  const outcome = await pipeline.run(TASK_ID, TRANSITION_TOKEN);

  assert.equal(outcome, 'superseded');
  assert.equal(recorder.of('sandbox.provisioned').length, 0);
  assert.equal(recorder.of('task.superseded').length, 1);
});

test('a run that finds the task terminally fenced after provisioning publishes no SandboxProvisioned', async () => {
  const recorder = recordingOrchestrator({ terminallyFenced: true });
  const pipeline = new InlineAdmissionPipeline(
    recorder.orchestrator,
    provisioningSandbox(),
  );

  const outcome = await pipeline.run(TASK_ID, TRANSITION_TOKEN);

  assert.equal(outcome, 'superseded');
  // The sandbox this attempt created is discarded, so announcing it would name a
  // sandbox that no longer exists.
  assert.equal(recorder.of('sandbox.provisioned').length, 0);
  assert.equal(recorder.of('task.superseded').length, 1);
});

test('a run that ends in its own failure rather than a supersession publishes nothing', async () => {
  // No provider, and the forced failure IS this attempt's own recorded terminal
  // status — so the run ends `transitioned`, not `superseded`.
  const recorder = recordingOrchestrator({ terminalStatus: 'failed' });
  const pipeline = new InlineAdmissionPipeline(recorder.orchestrator);

  const outcome = await pipeline.run(TASK_ID, TRANSITION_TOKEN);

  assert.equal(outcome, 'transitioned');
  assert.equal(recorder.published.length, 0);
});

test('a run whose forced failure lost the terminal race reports one supersession', async () => {
  // Same absent provider, but another actor owns the terminal status: this run
  // observed that it lost, which is exactly one supersession — and still no
  // sandbox was provisioned to announce.
  const recorder = recordingOrchestrator();
  const pipeline = new InlineAdmissionPipeline(recorder.orchestrator);

  const outcome = await pipeline.run(TASK_ID, TRANSITION_TOKEN);

  assert.equal(outcome, 'superseded');
  assert.equal(recorder.of('task.superseded').length, 1);
  assert.equal(recorder.of('sandbox.provisioned').length, 0);
});

test('the pipeline body publishes supersession only at the single run exit', () => {
  const source = readFileSync(
    join(resolve(__dirname, '..', '..', 'src'), 'inline-admission', 'inline-admission.pipeline.ts'),
    'utf8',
  );

  // Many internal early returns…
  const supersededReturns = (source.match(/return 'superseded';/g) ?? []).length;
  assert(
    supersededReturns > 1,
    'the fixture assumes the body still has multiple superseded early returns',
  );
  // …but exactly one publish, and it is not inside the provisioning body.
  assert.equal(
    (source.match(/publishRunSupersession\(/g) ?? []).length,
    1,
  );
  const body = source.slice(source.indexOf('private async runProvisioning('));
  assert.doesNotMatch(body, /publishRunSupersession\(/);
});
