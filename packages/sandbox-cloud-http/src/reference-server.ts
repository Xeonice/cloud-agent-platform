import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { HttpCloudSandboxFetch } from './http-cloud-provider.js';

/**
 * HTTP cloud sandbox REFERENCE SERVER — deliberately named a reference server,
 * not a mock (unlock-extension-axes D8; MCP "everything" precedent). It is the
 * executable documentation of the control-plane protocol in this package's
 * README: a real bound HTTP listener implementing all 7 required endpoints,
 * and the peer the conformance suite exercises over real HTTP. A hand-written
 * fetch stub can silently mirror the provider's own assumptions while the
 * README drifts; a shared listener cannot — divergence turns conformance red.
 *
 * Reference semantics beyond the happy path (documented behavior, not test
 * scaffolding):
 * - `POST /v1/sandboxes` is idempotent per task id: a replay returns the
 *   stored representation. A replay naming a DIFFERENT resource generation is
 *   a conflicting incarnation and is refused with 409.
 * - Ownership fencing is adopt-on-first-fence: when a sandbox was created
 *   without a resource generation, the first fenced request (reattach with a
 *   generation, or a fenced DELETE) records the offered generation as the
 *   sandbox's fence. Once a fence is recorded, a mismatched `If-Match` fails
 *   closed with 412 and a mismatched provider sandbox id with 409.
 * - Unfenced DELETE remains allowed (legacy compatibility — the README pins
 *   `404` as idempotent success for the same reason).
 * - `DELETE` is an acknowledgement only; callers prove the terminal state via
 *   `GET` (absence for `superseded-remove`, `status: "retained"` for
 *   `terminal-retain`), matching the provider's confirm-after-accept loop.
 */

/**
 * Specification version this package's provider prefers, plus the full set it
 * supports. Ruling on the open question (unlock-extension-axes task 6.4): the
 * specification version is NOT embedded in the provider declaration object
 * (`defineHttpCloudSandboxProvider` / `SandboxProviderDescriptor`). Version
 * self-description is an optional, connection-time discovery concern; keeping
 * it out of the descriptor keeps baseline servers (no self-description at all)
 * first-class and the declaration object version-agnostic.
 */
export const HTTP_CLOUD_SANDBOX_SPECIFICATION_VERSION = '1.0';

export const HTTP_CLOUD_SANDBOX_SUPPORTED_SPECIFICATION_VERSIONS: readonly string[] =
  Object.freeze([HTTP_CLOUD_SANDBOX_SPECIFICATION_VERSION]);

/** Advisory capability names for the 7 required README endpoints. */
export const HTTP_CLOUD_SANDBOX_REFERENCE_CAPABILITIES: readonly string[] =
  Object.freeze([
    'sandbox.create',
    'sandbox.inspect',
    'sandbox.delete',
    'transcript.retained-read',
    'workspace.deliver',
    'lifecycle.readoptable',
    'lifecycle.reattach',
  ]);

export interface HttpCloudSandboxRetainedTranscript {
  readonly format: string;
  readonly jsonl: string;
}

/**
 * Retained transcript the reference server serves for every created sandbox
 * unless the deployment opts out (`retainedTranscript: null`).
 */
export const HTTP_CLOUD_SANDBOX_REFERENCE_TRANSCRIPT: HttpCloudSandboxRetainedTranscript =
  Object.freeze({
    format: 'codex-rollout',
    jsonl: '{"type":"turn","text":"cap cloud reference transcript"}\n',
  });

export interface HttpCloudSandboxSelfDescription {
  readonly specificationVersion: string;
  readonly supportedSpecificationVersions?: readonly string[];
  readonly capabilities?: readonly string[];
}

export interface HttpCloudSandboxReferenceServerOptions {
  /** When set, every `/v1` route requires `Authorization: Bearer <apiToken>`. */
  readonly apiToken?: string;
  /**
   * Optional protocol self-description (`GET /v1/self-description`). Absent by
   * default: the default reference server is a BASELINE server implementing
   * only the 7 required endpoints, because self-description is a purely
   * additive extension and baseline servers must stay first-class.
   */
  readonly selfDescription?: HttpCloudSandboxSelfDescription;
  /** Retained transcript per sandbox; `null` disables transcript retention. */
  readonly retainedTranscript?: HttpCloudSandboxRetainedTranscript | null;
}

/** One request observed by the bound listener, in arrival order. */
export interface HttpCloudSandboxReferenceServerRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface HttpCloudSandboxReferenceServer {
  readonly baseUrl: string;
  /** Every request the listener observed — evidence for coverage assertions. */
  readonly requests: readonly HttpCloudSandboxReferenceServerRequest[];
  close(): Promise<void>;
}

interface ReferenceSandboxRecord {
  readonly taskId: string;
  readonly providerSandboxId: string;
  resourceGeneration: string | undefined;
  status: 'running' | 'retained';
  readonly transcript: HttpCloudSandboxRetainedTranscript | null;
}

export async function startHttpCloudSandboxReferenceServer(
  options: HttpCloudSandboxReferenceServerOptions = {},
): Promise<HttpCloudSandboxReferenceServer> {
  const sandboxes = new Map<string, ReferenceSandboxRecord>();
  const requests: HttpCloudSandboxReferenceServerRequest[] = [];
  const transcriptTemplate =
    options.retainedTranscript === undefined
      ? HTTP_CLOUD_SANDBOX_REFERENCE_TRANSCRIPT
      : options.retainedTranscript;
  let baseUrl = '';

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'reference server internal error' });
      } else {
        res.end();
      }
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', baseUrl);
    const body = parseJson(await readBody(req));
    requests.push({
      method,
      pathname: url.pathname,
      search: url.search,
      headers: flattenHeaders(req),
      body,
    });

    if (options.apiToken !== undefined) {
      if (req.headers.authorization !== `Bearer ${options.apiToken}`) {
        sendJson(res, 401, { error: 'missing or invalid bearer token' });
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/v1/self-description') {
      if (options.selfDescription === undefined) {
        // Baseline server: the optional extension is absent, not broken.
        sendJson(res, 404, { error: 'self-description not implemented' });
        return;
      }
      sendJson(res, 200, {
        data: {
          service: 'cap-http-cloud-sandbox-reference-server',
          specificationVersion: options.selfDescription.specificationVersion,
          supportedSpecificationVersions:
            options.selfDescription.supportedSpecificationVersions ?? [
              options.selfDescription.specificationVersion,
            ],
          capabilities:
            options.selfDescription.capabilities ??
            HTTP_CLOUD_SANDBOX_REFERENCE_CAPABILITIES,
        },
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/sandboxes') {
      createSandbox(res, body);
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/sandboxes/readoptable') {
      const readoptable = [...sandboxes.values()]
        .filter((record) => record.status === 'running')
        .map((record) => record.taskId);
      sendJson(res, 200, { data: readoptable });
      return;
    }

    const sandboxRoute = matchSandboxRoute(url.pathname);
    if (sandboxRoute !== undefined) {
      const record = sandboxes.get(sandboxRoute.taskId);
      if (record === undefined) {
        sendJson(res, 404, { error: 'sandbox not found' });
        return;
      }
      switch (sandboxRoute.action) {
        case 'resource':
          if (method === 'GET') {
            sendJson(res, 200, { data: representation(record) });
            return;
          }
          if (method === 'DELETE') {
            deleteSandbox(res, record, req, body);
            return;
          }
          break;
        case 'transcript':
          if (method !== 'GET') break;
          if (record.transcript === null) {
            res.statusCode = 204;
            res.end();
            return;
          }
          sendJson(res, 200, { data: record.transcript });
          return;
        case 'deliver':
          if (method !== 'POST') break;
          deliver(res, record, body);
          return;
        case 'reattach':
          if (method !== 'POST') break;
          reattach(res, record, req, body);
          return;
      }
    }

    sendJson(res, 404, { error: 'not found' });
  }

  function createSandbox(res: ServerResponse, body: unknown): void {
    const record = asRecord(body);
    const taskId = record?.taskId;
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      sendJson(res, 422, { error: 'taskId is required' });
      return;
    }
    const offeredGeneration =
      typeof record?.resourceGeneration === 'string'
        ? record.resourceGeneration
        : undefined;
    const existing = sandboxes.get(taskId);
    if (existing !== undefined) {
      if (
        offeredGeneration !== undefined &&
        existing.resourceGeneration !== undefined &&
        offeredGeneration !== existing.resourceGeneration
      ) {
        sendJson(res, 409, { error: 'conflicting resource generation' });
        return;
      }
      // Idempotent create replay: same task, same stored representation.
      sendJson(res, 200, { data: connectionRepresentation(existing) });
      return;
    }
    const created: ReferenceSandboxRecord = {
      taskId,
      providerSandboxId: `cloud-ref-${taskId}`,
      resourceGeneration: offeredGeneration,
      status: 'running',
      transcript: transcriptTemplate,
    };
    sandboxes.set(taskId, created);
    sendJson(res, 200, { data: connectionRepresentation(created) });
  }

  function deleteSandbox(
    res: ServerResponse,
    record: ReferenceSandboxRecord,
    req: IncomingMessage,
    body: unknown,
  ): void {
    if (!fence(res, record, req, body)) return;
    const disposition = asRecord(body)?.disposition;
    if (disposition === 'terminal-retain') {
      record.status = 'retained';
    } else {
      sandboxes.delete(record.taskId);
    }
    res.statusCode = 204;
    res.end();
  }

  function deliver(
    res: ServerResponse,
    record: ReferenceSandboxRecord,
    body: unknown,
  ): void {
    const args = asRecord(body);
    if (
      typeof args?.authHeader !== 'string' ||
      typeof args.branch !== 'string' ||
      typeof args.commitMessage !== 'string'
    ) {
      sendJson(res, 422, {
        error: 'deliver requires authHeader, branch, and commitMessage',
      });
      return;
    }
    const commitSha = createHash('sha1')
      .update(`${record.taskId}\n${args.branch}\n${args.commitMessage}`)
      .digest('hex');
    sendJson(res, 200, {
      data: { hadChanges: true, commitSha, error: null },
    });
  }

  function reattach(
    res: ServerResponse,
    record: ReferenceSandboxRecord,
    req: IncomingMessage,
    body: unknown,
  ): void {
    if (!fence(res, record, req, body)) return;
    sendJson(res, 200, { data: connectionRepresentation(record) });
  }

  /**
   * Shared ownership fence: verifies provider sandbox id and resource
   * generation from the body / `If-Match` header, adopting the generation on
   * first sight when none is recorded. Returns false after responding.
   */
  function fence(
    res: ServerResponse,
    record: ReferenceSandboxRecord,
    req: IncomingMessage,
    body: unknown,
  ): boolean {
    const parsed = asRecord(body);
    if (
      typeof parsed?.providerSandboxId === 'string' &&
      parsed.providerSandboxId !== record.providerSandboxId
    ) {
      sendJson(res, 409, { error: 'provider sandbox id mismatch' });
      return false;
    }
    const offered =
      unquoteEntityTag(req.headers['if-match']) ??
      (typeof parsed?.resourceGeneration === 'string'
        ? parsed.resourceGeneration
        : undefined);
    if (offered !== undefined) {
      if (record.resourceGeneration === undefined) {
        record.resourceGeneration = offered;
      } else if (record.resourceGeneration !== offered) {
        sendJson(res, 412, { error: 'resource generation mismatch' });
        return false;
      }
    }
    return true;
  }

  function representation(record: ReferenceSandboxRecord): Record<string, unknown> {
    return {
      taskId: record.taskId,
      providerSandboxId: record.providerSandboxId,
      ...(record.resourceGeneration === undefined
        ? {}
        : { resourceGeneration: record.resourceGeneration }),
      status: record.status,
    };
  }

  function connectionRepresentation(
    record: ReferenceSandboxRecord,
  ): Record<string, unknown> {
    return {
      ...representation(record),
      baseUrl: `${baseUrl}/sandboxes/${encodeURIComponent(record.taskId)}`,
      wsUrl: `${baseUrl.replace(/^http/, 'ws')}/sandboxes/${encodeURIComponent(record.taskId)}/ws`,
    };
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export type HttpCloudSpecificationNegotiationOutcome =
  | { readonly kind: 'baseline' }
  | { readonly kind: 'negotiated'; readonly specificationVersion: string }
  | {
      readonly kind: 'version-mismatch';
      readonly clientVersions: readonly string[];
      readonly serverVersions: readonly string[];
    };

export interface HttpCloudSpecificationNegotiationOptions {
  readonly baseUrl: string;
  readonly apiToken?: string;
  readonly clientVersions?: readonly string[];
  readonly timeoutMs?: number;
  readonly fetch?: HttpCloudSandboxFetch;
}

/**
 * Optional capability/version self-description discovery (MCP initialize
 * idiom), purely additive over the 7 required endpoints:
 *
 * - A server without the endpoint (or one answering it unusably) is a
 *   BASELINE server — graceful degradation, never an error.
 * - Version negotiation counter-offers: when the server advertises a
 *   different preferred specification version, the outcome is a mutually
 *   supported version when one exists, and otherwise a typed
 *   `version-mismatch` result naming both sides' versions — never a blanket
 *   rejection of the server.
 */
export async function negotiateHttpCloudSpecification(
  options: HttpCloudSpecificationNegotiationOptions,
): Promise<HttpCloudSpecificationNegotiationOutcome> {
  const clientVersions =
    options.clientVersions ?? HTTP_CLOUD_SANDBOX_SUPPORTED_SPECIFICATION_VERSIONS;
  const fetchImpl: HttpCloudSandboxFetch =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, init));
  const base = options.baseUrl.trim().replace(/\/$/, '');
  let response;
  try {
    response = await fetchImpl(`${base}/v1/self-description`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(options.apiToken === undefined
          ? {}
          : { authorization: `Bearer ${options.apiToken}` }),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    // Discovery is advisory; the 7 required endpoints remain the contract.
    return { kind: 'baseline' };
  }
  if (!response.ok) return { kind: 'baseline' };
  const raw = await response.json().catch(() => undefined);
  const data = asRecord(asRecord(raw)?.data ?? raw);
  const advertised = data?.specificationVersion;
  if (typeof advertised !== 'string' || advertised.trim() === '') {
    return { kind: 'baseline' };
  }
  const serverVersions = [
    ...new Set([
      advertised,
      ...(Array.isArray(data?.supportedSpecificationVersions)
        ? data.supportedSpecificationVersions.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : []),
    ]),
  ];
  if (clientVersions.includes(advertised)) {
    return { kind: 'negotiated', specificationVersion: advertised };
  }
  const counterOffer = clientVersions.find((version) =>
    serverVersions.includes(version),
  );
  if (counterOffer !== undefined) {
    return { kind: 'negotiated', specificationVersion: counterOffer };
  }
  return {
    kind: 'version-mismatch',
    clientVersions: [...clientVersions],
    serverVersions,
  };
}

function matchSandboxRoute(
  pathname: string,
):
  | {
      readonly taskId: string;
      readonly action: 'resource' | 'transcript' | 'deliver' | 'reattach';
    }
  | undefined {
  const match = /^\/v1\/sandboxes\/([^/]+)(?:\/(transcript|deliver|reattach))?$/.exec(
    pathname,
  );
  if (match === null) return undefined;
  const taskId = decodeURIComponent(match[1] ?? '');
  const suffix = match[2];
  if (suffix === undefined) {
    // Method decides between inspect and delete on the bare resource path.
    return { taskId, action: 'resource' };
  }
  return { taskId, action: suffix as 'transcript' | 'deliver' | 'reattach' };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(raw: string): unknown {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function flattenHeaders(req: IncomingMessage): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(', ');
  }
  return headers;
}

function unquoteEntityTag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^"(.*)"$/.exec(value);
  if (match === null) return value;
  return (match[1] ?? '').replaceAll('\\"', '"').replaceAll('\\\\', '\\');
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}
