/**
 * Secret-canary family — the injection / exactly-once / zero-leakage assertion
 * vocabulary PORTED from
 * `packages/sandbox-conformance/src/workspace-git-conformance.ts` (one unique
 * canary value reused by every secret-leak assertion; `occurrences(...) === 1`
 * inside provider-private material; `assertNoSecret` across every surface that
 * crosses the execution boundary), applied to the runtime credential seams as
 * characterized by `apps/api/src/agent-runtime/agent-runtime.test.mjs` (the
 * golden setup/trim emitters: private 0600 files carry the bytes; commands,
 * plan serialization, and launch argv never do; pre-stop trim PROVES the
 * credential-bearing paths absent).
 */
import assert from 'node:assert/strict';

import { createSandboxRuntimePrivateFilePort } from '@cap-console/sandbox';
import type { SandboxProviderPrivateSecretFileWriteRequest } from '@cap-console/sandbox';

import type {
  ConformanceSetupCommand,
  RuntimeHarness,
} from '../harness.js';

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

/** Zero-leakage: the canary must not survive serialization of the surface. */
function assertNoSecret(value: unknown, canary: string, message: string): void {
  assert.equal(JSON.stringify(value)?.includes(canary), false, message);
}

/**
 * Consume the plan's one-shot private files through the provider-neutral
 * private-file port (the same channel production uses), collecting the decoded
 * bytes per path. Suite-owned mechanism; the runtime only emitted the plan.
 */
async function consumePrivateFiles(
  commands: readonly ConformanceSetupCommand[],
): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  const port = createSandboxRuntimePrivateFilePort({
    rootDirectory: '/home/gem',
    transport: {
      async writeFile(request: SandboxProviderPrivateSecretFileWriteRequest) {
        files.set(request.path, new TextDecoder().decode(request.content));
      },
      async deleteFile() {
        // The conformance transport never deletes.
      },
    },
  });
  for (const command of commands) {
    for (const file of command.privateFiles ?? []) {
      await port.writeFile(file);
    }
  }
  return files;
}

export async function runSecretCanaryFamily(
  harness: RuntimeHarness,
): Promise<void> {
  const { runtime, hooks } = harness;
  const c = hooks.secretCanary;

  for (const variant of c.variants) {
    const plan = runtime.sandboxSetupCommands(c.setupContext, variant.material);
    if (!plan.ok) {
      assert.fail(
        `${runtime.id}/${variant.label}: canary credential must produce a setup plan (got: ${plan.reason})`,
      );
    }

    // Exactly-once injection: the canary lands in provider-private file bytes
    // exactly once across the whole plan.
    const files = await consumePrivateFiles(plan.commands);
    const totalInPrivateFiles = [...files.values()].reduce(
      (sum, content) => sum + occurrences(content, c.canary),
      0,
    );
    assert.equal(
      totalInPrivateFiles,
      1,
      `${runtime.id}/${variant.label}: the canary must exist only once inside the provider-private configuration`,
    );

    // Zero leakage across the execution boundary: plan serialization, command
    // text (including derived encodings), and every launch argv are canary-free.
    assertNoSecret(
      plan,
      c.canary,
      `${runtime.id}/${variant.label}: the setup plan serialization must be secret-free`,
    );
    for (const command of plan.commands) {
      assert.equal(
        occurrences(command.command, c.canary),
        0,
        `${runtime.id}/${variant.label}: setup command text must be secret-free`,
      );
      assert.ok(
        !command.command.includes('base64'),
        `${runtime.id}/${variant.label}: setup commands must not smuggle bytes via base64`,
      );
    }
    const launchLines = [runtime.buildLaunchLine(hooks.launch.context)];
    if (runtime.buildHeadlessLine && hooks.headless) {
      launchLines.push(runtime.buildHeadlessLine(hooks.headless.context));
    }
    for (const line of launchLines) {
      assert.equal(
        occurrences(line, c.canary),
        0,
        `${runtime.id}/${variant.label}: launch argv must be secret-free`,
      );
    }
  }

  // ---- absent credential policy -------------------------------------------
  const absentPlan = runtime.sandboxSetupCommands(c.setupContext, null);
  if (c.absentCredential === 'fail-closed') {
    assert.equal(
      absentPlan.ok,
      false,
      `${runtime.id}: an absent credential must fail closed before any command`,
    );
  } else {
    assert.equal(
      absentPlan.ok,
      true,
      `${runtime.id}: an absent credential degrades (never a hidden failure)`,
    );
  }
  if (c.blankMaterial) {
    assert.equal(
      runtime.sandboxSetupCommands(c.setupContext, c.blankMaterial).ok,
      false,
      `${runtime.id}: a blank credential must fail closed`,
    );
  }

  // ---- pre-stop trim proves the credential-bearing paths absent -----------
  const trim = runtime.preStopTrimCommands();
  for (const path of c.trimProvesAbsent) {
    assert.ok(
      trim.some((command) => command.includes(`test ! -e ${path}`)),
      `${runtime.id}: pre-stop trim must PROVE ${path} absent`,
    );
  }
  for (const command of trim) {
    assert.equal(
      occurrences(command, c.canary),
      0,
      `${runtime.id}: pre-stop trim commands must be secret-free`,
    );
  }
}
