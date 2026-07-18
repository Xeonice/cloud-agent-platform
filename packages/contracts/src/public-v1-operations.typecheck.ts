import {
  PUBLIC_V1_OPERATIONS,
  type McpMappedOperationId,
  type PublicV1OperationById,
} from './public-v1-operations.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

// The tuple and per-id projection retain literal metadata rather than widening
// every entry back to the authoring constraint.
type _FirstIdIsExact = Expect<
  Equal<(typeof PUBLIC_V1_OPERATIONS)[0]['id'], 'tasks.create'>
>;
type _CreateScopeIsExact = Expect<
  Equal<PublicV1OperationById<'tasks.create'>['scope'], 'tasks:write'>
>;
type _CreateToolIsExact = Expect<
  Equal<
    PublicV1OperationById<'tasks.create'>['mcp']['tool'],
    'create_task'
  >
>;
type _EventsRemainExcluded = Expect<
  Equal<
    PublicV1OperationById<'tasks.events'>['mcp']['excluded'],
    'MCP tools use request/response transport; lifecycle SSE is REST-only.'
  >
>;
type _DiagnosticsIdIsExact = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['id'],
    'tasks.provisioningDiagnostics'
  >
>;
type _DiagnosticsScopeIsExact = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['scope'],
    'tasks:diagnostics'
  >
>;
type _DiagnosticsMethodIsExact = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['method'],
    'get'
  >
>;
type _DiagnosticsPathIsExact = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['path'],
    '/v1/tasks/{id}/provisioning-diagnostics'
  >
>;
type _DiagnosticsSuccessStatusIsExact = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['successStatus'],
    200
  >
>;
type _DiagnosticsOwnerPolicyIsRequired = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['ownerPolicy'],
    'required'
  >
>;
type _DiagnosticsUnavailableErrorIsExact = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['errors'][4],
    'task_provisioning_diagnostics_unavailable'
  >
>;
type _DiagnosticsMcpToolIsExact = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['mcp']['tool'],
    'get_task_provisioning_diagnostics'
  >
>;
type _DiagnosticsMcpInputIsExact = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['mcp']['inputProjection']['sources'],
    readonly ['params', 'query']
  >
>;
type _DiagnosticsMcpOutputIsCanonical = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['mcp']['outputProjection'],
    'canonical'
  >
>;
type _DiagnosticsHasNoProtocolDifferences = Expect<
  Equal<
    PublicV1OperationById<'tasks.provisioningDiagnostics'>['mcp']['differences'],
    readonly []
  >
>;
type _DiagnosticsExampleKeysAreExact = Expect<
  Equal<
    keyof PublicV1OperationById<'tasks.provisioningDiagnostics'>['responseExamples'],
    'notStarted' | 'partialPrimaryAndCleanup' | 'historicalUnavailable'
  >
>;

const mappedOperationId: McpMappedOperationId = 'tasks.create';
void mappedOperationId;

// @ts-expect-error An explicitly excluded REST operation cannot key an MCP map.
const excludedMcpOperationId: McpMappedOperationId = 'tasks.events';
void excludedMcpOperationId;

const diagnosticsMcpOperationId: McpMappedOperationId =
  'tasks.provisioningDiagnostics';
void diagnosticsMcpOperationId;

// @ts-expect-error Per-id lookup rejects ids outside the exact registry union.
type _UnknownOperation = PublicV1OperationById<'unknown.operation'>;
