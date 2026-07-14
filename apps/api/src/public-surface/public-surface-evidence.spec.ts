import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';

import { PUBLIC_V1_OPERATIONS, type McpMappedOperation } from '@cap/contracts';

import { MCP_ADAPTERS, type McpAdapterMap } from '../mcp/mcp-tools';
import { collectPublicSurfaceRuntimeEvidence } from './public-surface-evidence';

function mappedOperations(): readonly McpMappedOperation[] {
  return PUBLIC_V1_OPERATIONS.filter(
    (operation): operation is McpMappedOperation => 'tool' in operation.mcp,
  );
}

test('focused collector emits exact reflected, SDK, and adapter evidence', async () => {
  const evidence = await collectPublicSurfaceRuntimeEvidence();
  const outputPath = process.env.CAP_PUBLIC_SURFACE_EVIDENCE_PATH;
  if (outputPath) {
    // Emit before assertions so a real mutation that fails this focused test is
    // still available to the parent verifier as a precise field-level finding.
    writeFileSync(outputPath, `${JSON.stringify(evidence)}\n`, 'utf8');
  }
  assert.equal(evidence.version, 1);
  assert.deepEqual(
    evidence.operations.map((operation) => operation.id),
    PUBLIC_V1_OPERATIONS.map((operation) => operation.id),
  );
  for (const operation of evidence.operations) {
    assert.equal(operation.rest.present, true, `${operation.id} REST presence`);
    assert.deepEqual(
      operation.rest.inputFields,
      operation.registry.rest.inputFields,
      `${operation.id} REST reflected fields`,
    );
    assert.deepEqual(
      operation.rest.forwardedInputFields,
      operation.registry.rest.inputFields,
      `${operation.id} REST handler input consumption`,
    );
    if (operation.registry.mcp.status === 'excluded') {
      assert.equal(operation.mcp.present, false, `${operation.id} MCP exclusion`);
      continue;
    }
    assert.equal(operation.mcp.present, true, `${operation.id} MCP presence`);
    if (!operation.mcp.present) continue;
    assert.equal(operation.mcp.tool, operation.registry.mcp.tool);
    assert.deepEqual(
      operation.mcp.inputFields,
      operation.registry.mcp.inputFields,
      `${operation.id} MCP SDK input fields`,
    );
    assert.deepEqual(
      operation.mcp.forwardedInputFields,
      operation.registry.mcp.inputFields,
      `${operation.id} MCP adapter forwarding`,
    );
  }
});

test('focused collector exposes an MCP field-stripping adapter mutation', async () => {
  const operation = mappedOperations().find(
    (candidate) => candidate.mcp.inputProjection.sources.length > 0,
  );
  assert.ok(operation);
  const baseline = await collectPublicSurfaceRuntimeEvidence();
  const baselineOperation = baseline.operations.find(
    (candidate) => candidate.id === operation.id,
  );
  assert.ok(baselineOperation);
  assert.equal(baselineOperation.registry.mcp.status, 'mapped');
  const strippedField = baselineOperation.registry.mcp.inputFields[0];
  assert.ok(strippedField);

  const original = MCP_ADAPTERS[operation.id];
  const mutated = {
    ...MCP_ADAPTERS,
    [operation.id]: {
      ...original,
      async execute(
        input: Record<string, unknown>,
        context: unknown,
      ): Promise<unknown> {
        const stripped = { ...input };
        delete stripped[strippedField];
        return (original.execute as (
          value: Record<string, unknown>,
          adapterContext: unknown,
        ) => Promise<unknown>)(stripped, context);
      },
    },
  } as unknown as McpAdapterMap;
  const evidence = await collectPublicSurfaceRuntimeEvidence(mutated);
  const mutatedOperation = evidence.operations.find(
    (candidate) => candidate.id === operation.id,
  );
  assert.ok(mutatedOperation?.mcp.present);
  assert.ok(
    !mutatedOperation.mcp.forwardedInputFields.includes(strippedField),
    `${operation.id} collector must expose stripped ${strippedField}`,
  );
});
