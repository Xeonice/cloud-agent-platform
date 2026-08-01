import {
  RUNTIME_METADATA,
  type AgentRuntimeId,
  type RuntimeMetadata,
} from './agent-runtime-id.js';

/**
 * Compile-fail fixtures for the RUNTIME_METADATA policy table
 * (unlock-extension-axes D2), in the shape of the api's
 * `agent-runtime-registration.typecheck.ts`.
 *
 * A runtime test can prove that today's table covers today's declaration. Only
 * the compiler can prove that TOMORROW's declared runtime cannot ship without a
 * metadata row — the assignment below fails the ordinary typecheck naming the
 * missing key the moment `AGENT_RUNTIME_IDS` grows without a matching row.
 *
 * The probes deliberately stay behind `@ts-expect-error`. If the table's
 * declared type is ever weakened to a `Partial` or an index-signature shape —
 * which would restore the silent-gap behaviour (a declared runtime rendering
 * with no label/copy) — the directives become unused and the ordinary typecheck
 * fails. The fixture cannot be defeated by relaxing the thing it guards.
 *
 * This module is compile-only: it is not exported from the package index and
 * must never be imported at runtime (its `declare const` bindings do not exist).
 */

type RuntimeMetadataTable = Readonly<Record<AgentRuntimeId, RuntimeMetadata>>;

/**
 * The positive half: the actual table is assignable to the total shape. Adding
 * a runtime id without a metadata row turns THIS line red, naming the key.
 */
const tableIsTotal: RuntimeMetadataTable = RUNTIME_METADATA;
void tableIsTotal;

declare const withoutClaudeCode: Omit<RuntimeMetadataTable, 'claude-code'>;

// @ts-expect-error Every declared runtime must have a metadata row.
const missingRow: RuntimeMetadataTable = withoutClaudeCode;
void missingRow;

declare const withoutAny: Omit<RuntimeMetadataTable, keyof RuntimeMetadataTable>;

// @ts-expect-error An empty metadata table cannot satisfy the declaration.
const emptyTable: RuntimeMetadataTable = withoutAny;
void emptyTable;

/**
 * A `Partial` is the specific weakening that would make a missing row legal
 * again, so it is named here rather than left implicit.
 */
declare const partialRows: Partial<RuntimeMetadataTable>;

// @ts-expect-error The metadata table must be total, not partial.
const partialIsNotTotal: RuntimeMetadataTable = partialRows;
void partialIsNotTotal;

/** A free string is not a runtime id: lookups go through the declaration. */
declare const arbitraryKey: string;

// @ts-expect-error Rows are looked up by a declared runtime id, not a free string.
const rowForFreeString = RUNTIME_METADATA[arbitraryKey];
void rowForFreeString;
