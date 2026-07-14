import type {
  PublicErrorCode,
  PublicV1OperationShape,
} from '@cap/contracts';
import type { McpAdapterMap } from '../mcp/mcp-tools';

/**
 * Compile-fail fixtures for the two exhaustive public-surface records.
 *
 * These assignments deliberately remain behind `@ts-expect-error`: weakening
 * either contract to a string-indexed/optional shape makes the directive
 * unused and therefore fails the normal API typecheck.
 */
declare const adaptersWithEveryKeyRemoved: Omit<
  McpAdapterMap,
  keyof McpAdapterMap
>;

// @ts-expect-error A mapped public operation cannot be omitted from the MCP map.
const incompleteMcpAdapterMap: McpAdapterMap = adaptersWithEveryKeyRemoved;
void incompleteMcpAdapterMap;

declare const operationWithoutProtocolDecision: Omit<
  PublicV1OperationShape,
  'mcp'
>;

// @ts-expect-error Every public operation requires a mapped tool or exclusion.
const missingProtocolDecision: PublicV1OperationShape =
  operationWithoutProtocolDecision;
void missingProtocolDecision;

type PublicErrorSelectionMap = Readonly<Record<PublicErrorCode, unknown>>;
declare const errorMapWithEveryKeyRemoved: Omit<
  PublicErrorSelectionMap,
  keyof PublicErrorSelectionMap
>;

// @ts-expect-error Every stable public error requires a transport selection.
const incompletePublicErrorMap: PublicErrorSelectionMap =
  errorMapWithEveryKeyRemoved;
void incompletePublicErrorMap;
