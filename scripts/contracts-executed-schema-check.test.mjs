/**
 * Guards the contracts executed-schema gate.
 *
 * The lesson this repository paid for twice: a gate proved against a convenient
 * shape leaves the class it was built for walking through. The previous change's
 * import gate was proved with a throwaway export that had no schema/type twin —
 * the one shape its pair rule already handled — and a whole class of dead pairs
 * passed for a week.
 *
 * So the shape matters here. The defect this gate targets is a schema that IS
 * imported and IS composed into a live inferred type and is never parsed, which
 * is what `SmtpConfigReadSchema` looked like on the day it was wrong. A probe
 * that is merely unimported proves only that the OTHER gate still works.
 *
 * Run: node --test scripts/contracts-executed-schema-check.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parsesSchema, scan } from './contracts-executed-schema-check.mjs';

// ---- what counts as running a schema ---------------------------------------

test('every parse form this repository uses counts as execution', () => {
  const forms = [
    'const parsed = WidgetSchema.parse(body);',
    'const r = WidgetSchema.safeParse(body);',
    'await WidgetSchema.parseAsync(body);',
    'await WidgetSchema.safeParseAsync(body);',
    '@UsePipes(new ZodValidationPipe(WidgetSchema))',
  ];
  for (const form of forms) {
    assert.ok(parsesSchema(form, 'WidgetSchema'), `not seen as a parse: ${form}`);
  }
});

test('naming a schema is not running it', () => {
  // The whole distinction between this gate and the import gate. Each of these
  // makes the schema reachable by import while nothing validates anything.
  const nonUses = [
    // Reflection is not validation: it produces a document, not a verdict on any
    // bytes. The gate counted it until verification pointed out that it has zero
    // call sites AND would exempt the first OpenAPI-only reference added.
    'return zodToJsonSchema(WidgetSchema);',
    'import { WidgetSchema } from "@cap-console/contracts";',
    'export type Widget = z.infer<typeof WidgetSchema>;',
    'const registry = { widget: WidgetSchema };',
    'export { WidgetSchema };',
  ];
  for (const form of nonUses) {
    assert.equal(
      parsesSchema(form, 'WidgetSchema'),
      false,
      `counted as a parse but is not one: ${form}`,
    );
  }
});

test('a similarly named schema is not mistaken for the one asked about', () => {
  assert.equal(
    parsesSchema('WidgetListSchema.parse(body);', 'WidgetSchema'),
    false,
  );
});

// ---- the real tree ---------------------------------------------------------

test('the declared /v1 indirection is honoured', () => {
  // `parsePublicV1Input` calls `operation.input.query.parse` on a table entry,
  // so the call site names a property path and no text scan can attribute it.
  // Without the declared indirection point these four read as dead, and the gate
  // would open its life by crying wolf about the public API surface.
  const result = scan();
  for (const name of [
    'V1CreateTaskRequestSchema',
    'V1ListQuerySchema',
    'PublicV1IdParamsSchema',
    'PublicV1EventHeadersSchema',
  ]) {
    assert.equal(
      result.unexecuted.includes(name),
      false,
      `${name} reported unexecuted despite the declared /v1 indirection point`,
    );
  }
});

test('test-only execution is reported, not counted as executed', () => {
  const result = scan();
  assert.ok(
    result.testOnly.length > 0,
    'the tree has test-only schemas today; a zero here means the detection broke',
  );
  for (const name of result.testOnly) {
    // Either still on the failure list, or adjudicated as an exception. What must
    // NOT happen is a test-only schema quietly counting as executed: a test call
    // site proves the schema parses, not that anything on the wire conforms to it.
    assert.ok(
      result.unexecuted.includes(name) || result.excepted.includes(name),
      `${name} is test-only but is neither reported nor excepted`,
    );
  }
});

test('the scan actually looked at something', () => {
  // Floors, not exact counts: a scan that found nothing would report a clean
  // tree for the wrong reason, and an exact count turns ordinary growth red.
  const result = scan();
  assert.ok(result.schemas >= 300, `schemas: ${result.schemas}`);
  assert.ok(result.executed >= 200, `executed: ${result.executed}`);
});

test('every schema is executed, or excepted with a reason', () => {
  const result = scan();
  assert.deepEqual(
    result.unexecuted,
    [],
    `schemas nothing runs: ${result.unexecuted.join(', ')}`,
  );
});
