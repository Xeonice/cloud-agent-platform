import { performance } from 'node:perf_hooks';
import {
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_COLUMNS,
  MAX_TERMINAL_PIXEL_DIMENSION,
  MAX_TERMINAL_RESPONSE_BYTES,
  MAX_TERMINAL_ROWS,
  TerminalResponseProfileSchema,
  XTERM_5_5_0_RESPONSE_PROFILE,
  classifyTerminalResponseBytes,
  terminalResponseClassEnabled,
  type TerminalResponseClassification,
  type TerminalResponseProfile,
} from '@cap-console/contracts';

/** A short authorization window for an xterm response to an observed PTY query. */
export const DEFAULT_TERMINAL_QUERY_TTL_MS = 5_000;
/** No deployment configuration may enlarge the response authorization window past this. */
export const MAX_TERMINAL_QUERY_TTL_MS = 30_000;

export const DEFAULT_TERMINAL_QUERY_CAPACITY = 64;
export const MAX_TERMINAL_QUERY_CAPACITY = 256;

/** Terminal-response frames are additionally bounded even when queries are outstanding. */
export const DEFAULT_TERMINAL_RESPONSE_RATE_LIMIT = 128;
export const MAX_TERMINAL_RESPONSE_RATE_LIMIT = 512;
export const DEFAULT_TERMINAL_RESPONSE_RATE_WINDOW_MS = 1_000;
export const MAX_TERMINAL_RESPONSE_RATE_WINDOW_MS = 10_000;

/** Parser hard bounds are code constants, not deployment-tunable memory limits. */
export const MAX_TERMINAL_QUERY_SEQUENCE_BYTES = 2_048;
export const MAX_TERMINAL_QUERY_STRING_BYTES = 1_024;
export const MAX_TERMINAL_QUERY_CARRY_BYTES = 2_048;

type DecrqssSubtype =
  | 'sgr'
  | 'margins'
  | 'cursor_style'
  | 'protection'
  | 'conformance'
  | 'unknown';

/**
 * The finite response expectation created by one active-profile terminal query.
 * It deliberately contains only parameters that a later xterm response must preserve.
 */
export type TerminalQueryExpectation =
  | { readonly responseClass: 'da1' | 'da2' | 'dsr_status' | 'cpr' | 'private_cpr' }
  | {
      readonly responseClass: 'decrqm_ansi' | 'decrqm_private';
      readonly mode: number;
    }
  | {
      readonly responseClass: 'decrqss';
      readonly subtype: DecrqssSubtype;
    }
  | {
      readonly responseClass: 'osc_4';
      readonly colorIndex: number;
    }
  | { readonly responseClass: 'osc_10' | 'osc_11' | 'osc_12' }
  | { readonly responseClass: 'window_14' | 'window_16' | 'window_18' };

export type OutstandingTerminalQuery = TerminalQueryExpectation & {
  readonly id: number;
  readonly enqueuedAt: number;
  readonly expiresAt: number;
};

export interface TerminalQueryBatch {
  /** One OSC query can produce several independently correlated response tokens. */
  readonly queries: readonly TerminalQueryExpectation[];
  /** Exact transparent PTY bytes that produced this batch, across fragmentation. */
  readonly rawBytes: Uint8Array;
}

export interface TerminalQueryQueueFullEvent {
  readonly capacity: number;
  readonly pending: number;
  readonly requested: number;
  readonly queries: readonly TerminalQueryExpectation[];
}

export interface TerminalResponseRateLimitedEvent {
  readonly limit: number;
  readonly windowMs: number;
  readonly attemptsInWindow: number;
}

export interface TerminalQueryObserverOptions {
  readonly profile?: TerminalResponseProfile;
  readonly ttlMs?: number;
  readonly capacity?: number;
  readonly responseRateLimit?: number;
  readonly responseRateWindowMs?: number;
  /** Must be monotonic. Production defaults to `performance.now()`. */
  readonly now?: () => number;
  /** Diagnostic-only; callback failure never affects raw terminal delivery. */
  readonly onQueueFull?: (event: TerminalQueryQueueFullEvent) => void;
  /** Diagnostic-only; callback failure never changes response-gate state. */
  readonly onResponseRateLimited?: (event: TerminalResponseRateLimitedEvent) => void;
}

export interface TerminalQueryObservation {
  readonly recognized: readonly TerminalQueryExpectation[];
  readonly enqueued: readonly OutstandingTerminalQuery[];
  readonly refused: readonly TerminalQueryExpectation[];
  readonly observations: readonly {
    readonly query: TerminalQueryExpectation;
    readonly rawBytes: Uint8Array;
    readonly queryId: number | null;
    readonly admitted: boolean;
  }[];
  readonly pending: number;
}

export interface TerminalResponseGeometry {
  readonly cols: number;
  readonly rows: number;
}

export type TerminalResponseConsumeFailureReason =
  | 'closed'
  | 'clock_invalid'
  | 'rate_limited'
  | 'invalid_response'
  | 'profile_disabled'
  | 'invalid_geometry'
  | 'unmatched';

export type TerminalResponseConsumeResult =
  | {
      readonly accepted: true;
      readonly classification: TerminalResponseClassification;
      readonly query: OutstandingTerminalQuery;
    }
  | {
      readonly accepted: false;
      readonly reason: TerminalResponseConsumeFailureReason;
      readonly classification?: TerminalResponseClassification;
    };

export type TerminalResponseWriteResult =
  | {
      readonly accepted: true;
      readonly classification: TerminalResponseClassification;
      readonly query: OutstandingTerminalQuery;
    }
  | {
      readonly accepted: false;
      readonly reason: TerminalResponseConsumeFailureReason | 'closed_after_consume' | 'write_failed';
      readonly consumed: boolean;
      readonly classification?: TerminalResponseClassification;
      readonly query?: OutstandingTerminalQuery;
      readonly error?: unknown;
    };

/**
 * Load-bearing points in the lease-independent response transaction where the
 * Gateway revalidates the immutable attachment generation.  The observer owns
 * query syntax/TTL/single-consume state; the caller owns connection, auth, task,
 * and provider-attachment lifetime, so both authorities must still be live.
 */
export type TerminalResponseWriteCheckpoint =
  | 'before_validation'
  | 'after_validation'
  | 'after_consume';

export type TerminalResponseWriteFence = (
  checkpoint: TerminalResponseWriteCheckpoint,
) => boolean;

type TerminalResponseValidationResult =
  | {
      readonly accepted: true;
      readonly classification: TerminalResponseClassification;
    }
  | {
      readonly accepted: false;
      readonly reason: TerminalResponseConsumeFailureReason;
      readonly classification?: TerminalResponseClassification;
    };

export interface AccountedWriterTerminalResponse {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly classification: TerminalResponseClassification;
  readonly query: OutstandingTerminalQuery;
}

/**
 * Accounting is deliberately not an authorization result. A caller must
 * already hold the write lease and must write the original burst exactly once.
 */
export type TerminalWriterBurstAccountingResult =
  | {
      readonly inspected: true;
      readonly candidateCount: number;
      readonly consumed: readonly AccountedWriterTerminalResponse[];
    }
  | {
      readonly inspected: false;
      readonly reason: 'closed' | 'clock_invalid' | 'invalid_geometry' | 'burst_too_large';
      readonly candidateCount: 0;
      readonly consumed: readonly [];
    };

export class TerminalQueryObserverConfigurationError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalQueryObserverConfigurationError';
  }
}

type ParserState =
  | 'ground'
  | 'escape'
  | 'utf8-c1'
  | 'csi'
  | 'discard-csi'
  | 'string'
  | 'string-escape'
  | 'string-utf8-c1'
  | 'discard-string'
  | 'discard-string-escape'
  | 'discard-string-utf8-c1';

type StringKind = 'osc' | 'dcs';

const ESC = 0x1b;
const BEL = 0x07;
const UTF8_C1_LEAD = 0xc2;
const C1_DCS = 0x90;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

interface EmbeddedTerminalResponseSpan {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly classification: TerminalResponseClassification;
}

interface ControlIntroducer {
  readonly kind: 'csi' | 'osc' | 'dcs';
  readonly payloadOffset: number;
  readonly sevenBit: boolean;
}

function controlIntroducerAt(bytes: Uint8Array, offset: number): ControlIntroducer | null {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  if (first === ESC) {
    if (second === 0x5b) return { kind: 'csi', payloadOffset: offset + 2, sevenBit: true };
    if (second === 0x5d) return { kind: 'osc', payloadOffset: offset + 2, sevenBit: true };
    if (second === 0x50) return { kind: 'dcs', payloadOffset: offset + 2, sevenBit: true };
    return null;
  }
  if (first === C1_CSI) return { kind: 'csi', payloadOffset: offset + 1, sevenBit: false };
  if (first === C1_OSC) return { kind: 'osc', payloadOffset: offset + 1, sevenBit: false };
  if (first === C1_DCS) return { kind: 'dcs', payloadOffset: offset + 1, sevenBit: false };
  if (first === UTF8_C1_LEAD) {
    if (second === C1_CSI) return { kind: 'csi', payloadOffset: offset + 2, sevenBit: false };
    if (second === C1_OSC) return { kind: 'osc', payloadOffset: offset + 2, sevenBit: false };
    if (second === C1_DCS) return { kind: 'dcs', payloadOffset: offset + 2, sevenBit: false };
  }
  return null;
}

function findCsiEnd(bytes: Uint8Array, payloadOffset: number): number | null {
  for (let offset = payloadOffset; offset < bytes.length; offset += 1) {
    const byte = bytes[offset] ?? 0;
    if (byte === ESC || byte === C1_CSI || byte === C1_OSC || byte === C1_DCS) return null;
    if (byte >= CSI_FINAL_MIN && byte <= CSI_FINAL_MAX) return offset + 1;
  }
  return null;
}

function findStringEnd(
  bytes: Uint8Array,
  payloadOffset: number,
  allowBel: boolean,
): number | null {
  for (let offset = payloadOffset; offset < bytes.length; offset += 1) {
    const byte = bytes[offset];
    if (allowBel && byte === BEL) return offset + 1;
    if (byte === C1_ST) return offset + 1;
    if (byte === UTF8_C1_LEAD && bytes[offset + 1] === C1_ST) return offset + 2;
    if (byte === ESC) {
      if (bytes[offset + 1] === 0x5c) return offset + 2;
      // A response-looking sequence nested in an unrelated or unterminated
      // control string is ambiguous. Do not scan through it for accounting.
      return null;
    }
  }
  return null;
}

function isExactBytes(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  if (offset + expected.length > bytes.length) return false;
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

const BRACKETED_PASTE_START = [ESC, 0x5b, 0x32, 0x30, 0x30, 0x7e] as const;
const BRACKETED_PASTE_END = [ESC, 0x5b, 0x32, 0x30, 0x31, 0x7e] as const;

function findExactBytes(
  bytes: Uint8Array,
  start: number,
  expected: readonly number[],
): number | null {
  const lastStart = bytes.length - expected.length;
  for (let offset = start; offset <= lastStart; offset += 1) {
    if (isExactBytes(bytes, offset, expected)) return offset;
  }
  return null;
}

/**
 * Find only complete top-level responses. Unknown control strings and
 * bracketed-paste payloads are skipped as opaque regions so response-looking
 * pasted/nested bytes cannot consume authorization tokens.
 */
function findEmbeddedTerminalResponses(
  bytes: Uint8Array,
): readonly EmbeddedTerminalResponseSpan[] {
  const responses: EmbeddedTerminalResponseSpan[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (isExactBytes(bytes, offset, BRACKETED_PASTE_START)) {
      const pasteEnd = findExactBytes(
        bytes,
        offset + BRACKETED_PASTE_START.length,
        BRACKETED_PASTE_END,
      );
      if (pasteEnd === null) break;
      offset = pasteEnd + BRACKETED_PASTE_END.length;
      continue;
    }

    const introducer = controlIntroducerAt(bytes, offset);
    if (introducer === null) {
      offset += 1;
      continue;
    }
    const end =
      introducer.kind === 'csi'
        ? findCsiEnd(bytes, introducer.payloadOffset)
        : findStringEnd(bytes, introducer.payloadOffset, introducer.kind === 'osc');
    if (end === null) break;

    // The pinned xterm profile emits responses in 7-bit ESC form. C1 forms are
    // still parsed here as opaque controls so nested 7-bit bytes are not found.
    if (introducer.sevenBit && end - offset <= MAX_TERMINAL_RESPONSE_BYTES) {
      const classification = classifyTerminalResponseBytes(bytes.subarray(offset, end));
      if (classification !== null) {
        responses.push({
          byteOffset: offset,
          byteLength: end - offset,
          classification,
        });
      }
    }
    offset = end;
  }
  return responses;
}

function boundedInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TerminalQueryObserverConfigurationError(
      `${name} must be a positive integer no greater than ${maximum}`,
    );
  }
  return resolved;
}

function boundedFinite(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TerminalQueryObserverConfigurationError(
      `${name} must be finite, positive, and no greater than ${maximum}`,
    );
  }
  return resolved;
}

function parseMode(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const mode = Number(value);
  return Number.isSafeInteger(mode) && mode <= 999_999 ? mode : null;
}

function parseColorIndex(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const index = Number(value);
  return Number.isInteger(index) && index <= 255 ? index : null;
}

function enabledQuery(
  profile: TerminalResponseProfile,
  query: TerminalQueryExpectation,
): TerminalQueryExpectation | null {
  return terminalResponseClassEnabled(profile, query.responseClass) ? query : null;
}

function parseCsiParameters(value: string): readonly number[] | null {
  if (value === '') return [0];
  if (!/^\d*(?::\d*)*(?:;\d*(?::\d*)*)*$/.test(value)) return null;
  const parsed: number[] = [];
  for (const field of value.split(';')) {
    const primary = field.split(':', 1)[0] ?? '';
    const parameter = primary === '' ? 0 : Number(primary);
    if (!Number.isSafeInteger(parameter) || parameter < 0) return null;
    parsed.push(parameter);
  }
  return parsed;
}

function classifyCsiQuery(
  profile: TerminalResponseProfile,
  parameters: string,
  finalByte: number,
): readonly TerminalQueryExpectation[] {
  const final = String.fromCharCode(finalByte);
  let query: TerminalQueryExpectation | null = null;

  if (final === 'c') {
    const secondary = parameters.startsWith('>');
    const values = parseCsiParameters(secondary ? parameters.slice(1) : parameters);
    if (values?.[0] === 0) query = { responseClass: secondary ? 'da2' : 'da1' };
  } else if (final === 'n') {
    const privateQuery = parameters.startsWith('?');
    const values = parseCsiParameters(privateQuery ? parameters.slice(1) : parameters);
    if (!privateQuery && values?.[0] === 5) query = { responseClass: 'dsr_status' };
    if (!privateQuery && values?.[0] === 6) query = { responseClass: 'cpr' };
    if (privateQuery && values?.[0] === 6) query = { responseClass: 'private_cpr' };
  } else if (final === 'p') {
    const match = /^(\?)?(.*)\$$/.exec(parameters);
    if (match) {
      const values = parseCsiParameters(match[2] ?? '');
      const mode = values ? parseMode(String(values[0] ?? 0)) : null;
      if (mode !== null) {
        query = {
          responseClass: match[1] === '?' ? 'decrqm_private' : 'decrqm_ansi',
          mode,
        };
      }
    }
  } else if (final === 't') {
    const values = parseCsiParameters(parameters);
    if (values?.[0] === 14 && values[1] !== 2) query = { responseClass: 'window_14' };
    if (values?.[0] === 16) query = { responseClass: 'window_16' };
    if (values?.[0] === 18) query = { responseClass: 'window_18' };
  }

  if (query === null) return [];
  const enabled = enabledQuery(profile, query);
  return enabled === null ? [] : [enabled];
}

function classifyOscQuery(
  profile: TerminalResponseProfile,
  payload: string,
): readonly TerminalQueryExpectation[] {
  const fields = payload.split(';');
  const commandText = fields[0] ?? '';
  const command = /^\d+$/.test(commandText) ? Number(commandText) : Number.NaN;

  if (command === 4) {
    const queries: TerminalQueryExpectation[] = [];
    for (let index = 1; index + 1 < fields.length; index += 2) {
      const colorIndex = parseColorIndex(fields[index] ?? '');
      if (colorIndex === null || fields[index + 1] !== '?') continue;
      const query = enabledQuery(profile, { responseClass: 'osc_4', colorIndex });
      if (query !== null) queries.push(query);
    }
    return queries;
  }

  if (command !== 10 && command !== 11 && command !== 12) return [];
  const firstSlot = command;
  const reports = fields.slice(1);

  const queries: TerminalQueryExpectation[] = [];
  for (let offset = 0; offset < reports.length && firstSlot + offset <= 12; offset += 1) {
    if (reports[offset] !== '?') continue;
    const responseClass = `osc_${firstSlot + offset}` as 'osc_10' | 'osc_11' | 'osc_12';
    const query = enabledQuery(profile, { responseClass });
    if (query !== null) queries.push(query);
  }
  return queries;
}

function classifyDcsQuery(
  profile: TerminalResponseProfile,
  payload: string,
): readonly TerminalQueryExpectation[] {
  const match = /^(\d*(?::\d*)*(?:;\d*(?::\d*)*)*)?\$q([\x20-\x7e]*)$/.exec(payload);
  if (!match) return [];
  const request = match[2] ?? '';
  const subtype: DecrqssSubtype =
    request === 'm'
      ? 'sgr'
      : request === 'r'
        ? 'margins'
        : request === ' q'
          ? 'cursor_style'
          : request === '"q'
            ? 'protection'
            : request === '"p'
              ? 'conformance'
              : 'unknown';
  const query = enabledQuery(profile, { responseClass: 'decrqss', subtype });
  return query === null ? [] : [query];
}

/**
 * Incrementally observes PTY output without forwarding, rewriting, or suppressing it.
 * The caller remains the sole owner of the original byte stream.
 */
export class IncrementalTerminalQueryParser {
  private readonly profile: TerminalResponseProfile;
  private state: ParserState = 'ground';
  private stringKind: StringKind | null = null;
  private readonly carry: number[] = [];
  private readonly sequenceBytes: number[] = [];
  private sequenceLength = 0;

  constructor(profile: TerminalResponseProfile = XTERM_5_5_0_RESPONSE_PROFILE) {
    this.profile = TerminalResponseProfileSchema.parse(profile);
  }

  get carryBytes(): number {
    return Math.min(
      MAX_TERMINAL_QUERY_CARRY_BYTES,
      this.carry.length + (this.state === 'ground' ? 0 : 1),
    );
  }

  clear(): void {
    this.resetToGround();
  }

  observe(bytes: Uint8Array): readonly TerminalQueryBatch[] {
    const batches: TerminalQueryBatch[] = [];
    for (const byte of bytes) this.consumeByte(byte, batches);
    return batches;
  }

  private consumeByte(byte: number, batches: TerminalQueryBatch[]): void {
    switch (this.state) {
      case 'ground':
        this.consumeGround(byte);
        return;
      case 'escape':
        this.consumeEscape(byte);
        return;
      case 'utf8-c1':
        this.consumeUtf8C1(byte);
        return;
      case 'csi':
        this.consumeCsi(byte, batches);
        return;
      case 'discard-csi':
        if (byte >= 0x40 && byte <= 0x7e) this.resetToGround();
        return;
      case 'string':
        this.consumeString(byte, batches);
        return;
      case 'string-escape':
        this.consumeStringEscape(byte, batches);
        return;
      case 'string-utf8-c1':
        this.consumeStringUtf8C1(byte, batches);
        return;
      case 'discard-string':
        this.consumeDiscardString(byte);
        return;
      case 'discard-string-escape':
        this.consumeDiscardStringEscape(byte);
        return;
      case 'discard-string-utf8-c1':
        this.consumeDiscardStringUtf8C1(byte);
        return;
    }
  }

  private consumeGround(byte: number): void {
    if (byte === ESC) {
      this.state = 'escape';
      this.sequenceLength = 1;
      this.sequenceBytes.length = 0;
      this.sequenceBytes.push(byte);
      return;
    }
    if (byte === UTF8_C1_LEAD) {
      this.state = 'utf8-c1';
      this.sequenceLength = 1;
      this.sequenceBytes.length = 0;
      this.sequenceBytes.push(byte);
      return;
    }
    if (byte === C1_CSI || byte === C1_OSC || byte === C1_DCS) {
      this.sequenceBytes.length = 0;
      this.sequenceBytes.push(byte);
      if (byte === C1_CSI) this.startCsi(1);
      else if (byte === C1_OSC) this.startString('osc', 1);
      else this.startString('dcs', 1);
    }
  }

  private consumeEscape(byte: number): void {
    this.sequenceLength += 1;
    this.sequenceBytes.push(byte);
    if (byte === 0x5b) this.startCsi(this.sequenceLength);
    else if (byte === 0x5d) this.startString('osc', this.sequenceLength);
    else if (byte === 0x50) this.startString('dcs', this.sequenceLength);
    else this.resetToGround();
  }

  private consumeUtf8C1(byte: number): void {
    const length = this.sequenceLength + 1;
    this.sequenceBytes.push(byte);
    if (byte === C1_CSI) this.startCsi(length);
    else if (byte === C1_OSC) this.startString('osc', length);
    else if (byte === C1_DCS) this.startString('dcs', length);
    else {
      this.resetToGround();
      // A non-continuation byte was not part of the failed UTF-8 C1 form. It may
      // start a new top-level control sequence and is safe to reconsider.
      if (byte < 0x80 || byte > 0xbf) this.consumeGround(byte);
    }
  }

  private consumeCsi(byte: number, batches: TerminalQueryBatch[]): void {
    this.sequenceLength += 1;
    this.sequenceBytes.push(byte);
    if (this.sequenceLength > MAX_TERMINAL_QUERY_SEQUENCE_BYTES) {
      this.enterDiscardCsi();
      return;
    }
    if (byte >= 0x40 && byte <= 0x7e) {
      const parameters = String.fromCharCode(...this.carry);
      const queries = classifyCsiQuery(this.profile, parameters, byte);
      const rawBytes = Uint8Array.from(this.sequenceBytes);
      this.resetToGround();
      if (queries.length > 0) batches.push({ queries, rawBytes });
      return;
    }
    if (byte >= 0x20 && byte <= 0x3f && this.carry.length < MAX_TERMINAL_QUERY_CARRY_BYTES) {
      this.carry.push(byte);
      return;
    }
    this.enterDiscardCsi();
  }

  private consumeString(byte: number, batches: TerminalQueryBatch[]): void {
    this.sequenceLength += 1;
    this.sequenceBytes.push(byte);
    if (this.sequenceLength > MAX_TERMINAL_QUERY_SEQUENCE_BYTES) {
      this.enterDiscardString();
      return;
    }
    if (this.stringKind === 'osc' && byte === BEL) {
      this.completeString(batches);
      return;
    }
    if (byte === C1_ST) {
      this.completeString(batches);
      return;
    }
    if (byte === ESC) {
      this.state = 'string-escape';
      return;
    }
    if (byte === UTF8_C1_LEAD) {
      this.state = 'string-utf8-c1';
      return;
    }
    if (
      byte < 0x20 ||
      byte > 0x7e ||
      this.carry.length >= MAX_TERMINAL_QUERY_STRING_BYTES ||
      this.carry.length >= MAX_TERMINAL_QUERY_CARRY_BYTES
    ) {
      this.enterDiscardString();
      return;
    }
    this.carry.push(byte);
  }

  private consumeStringEscape(byte: number, batches: TerminalQueryBatch[]): void {
    this.sequenceLength += 1;
    this.sequenceBytes.push(byte);
    if (byte === 0x5c && this.sequenceLength <= MAX_TERMINAL_QUERY_SEQUENCE_BYTES) {
      this.completeString(batches);
      return;
    }
    this.enterDiscardString();
  }

  private consumeStringUtf8C1(byte: number, batches: TerminalQueryBatch[]): void {
    this.sequenceLength += 1;
    this.sequenceBytes.push(byte);
    if (byte === C1_ST && this.sequenceLength <= MAX_TERMINAL_QUERY_SEQUENCE_BYTES) {
      this.completeString(batches);
      return;
    }
    this.enterDiscardString();
  }

  private consumeDiscardString(byte: number): void {
    if (this.stringKind === 'osc' && byte === BEL) {
      this.resetToGround();
      return;
    }
    if (byte === C1_ST) {
      this.resetToGround();
      return;
    }
    if (byte === ESC) this.state = 'discard-string-escape';
    else if (byte === UTF8_C1_LEAD) this.state = 'discard-string-utf8-c1';
  }

  private consumeDiscardStringEscape(byte: number): void {
    if (byte === 0x5c) this.resetToGround();
    else if (byte !== ESC) this.state = 'discard-string';
  }

  private consumeDiscardStringUtf8C1(byte: number): void {
    if (byte === C1_ST) this.resetToGround();
    else this.state = byte === UTF8_C1_LEAD ? 'discard-string-utf8-c1' : 'discard-string';
  }

  private completeString(batches: TerminalQueryBatch[]): void {
    const kind = this.stringKind;
    const payload = String.fromCharCode(...this.carry);
    const queries =
      kind === 'osc'
        ? classifyOscQuery(this.profile, payload)
        : kind === 'dcs'
          ? classifyDcsQuery(this.profile, payload)
          : [];
    const rawBytes = Uint8Array.from(this.sequenceBytes);
    this.resetToGround();
    if (queries.length > 0) batches.push({ queries, rawBytes });
  }

  private startCsi(sequenceLength: number): void {
    this.state = 'csi';
    this.stringKind = null;
    this.sequenceLength = sequenceLength;
    this.carry.length = 0;
  }

  private startString(kind: StringKind, sequenceLength: number): void {
    this.state = 'string';
    this.stringKind = kind;
    this.sequenceLength = sequenceLength;
    this.carry.length = 0;
  }

  private enterDiscardCsi(): void {
    this.state = 'discard-csi';
    this.stringKind = null;
    this.carry.length = 0;
    this.sequenceBytes.length = 0;
  }

  private enterDiscardString(): void {
    this.state = 'discard-string';
    this.carry.length = 0;
    this.sequenceBytes.length = 0;
  }

  private resetToGround(): void {
    this.state = 'ground';
    this.stringKind = null;
    this.sequenceLength = 0;
    this.carry.length = 0;
    this.sequenceBytes.length = 0;
  }
}

interface QueueConfiguration {
  readonly profile: TerminalResponseProfile;
  readonly ttlMs: number;
  readonly capacity: number;
  readonly responseRateLimit: number;
  readonly responseRateWindowMs: number;
  readonly now: () => number;
  readonly onQueueFull?: (event: TerminalQueryQueueFullEvent) => void;
  readonly onResponseRateLimited?: (event: TerminalResponseRateLimitedEvent) => void;
}

function responseMatchesQuery(
  response: TerminalResponseClassification,
  query: OutstandingTerminalQuery,
  geometry: TerminalResponseGeometry,
): boolean {
  if (response.responseClass !== query.responseClass) return false;

  switch (query.responseClass) {
    case 'da1':
    case 'da2':
    case 'dsr_status':
      return true;
    case 'cpr':
    case 'private_cpr':
      return (
        (response.responseClass === 'cpr' || response.responseClass === 'private_cpr') &&
        response.row >= 1 &&
        response.row <= geometry.rows &&
        response.column >= 1 &&
        response.column <= geometry.cols
      );
    case 'decrqm_ansi':
    case 'decrqm_private':
      return (
        (response.responseClass === 'decrqm_ansi' ||
          response.responseClass === 'decrqm_private') &&
        response.mode === query.mode
      );
    case 'decrqss':
      return (
        response.responseClass === 'decrqss' &&
        response.subtype === query.subtype &&
        response.positive === (query.subtype !== 'unknown')
      );
    case 'osc_4':
      return response.responseClass === 'osc_4' && response.colorIndex === query.colorIndex;
    case 'osc_10':
    case 'osc_11':
    case 'osc_12':
      return true;
    case 'window_14':
    case 'window_16':
      return (
        (response.responseClass === 'window_14' || response.responseClass === 'window_16') &&
        response.height >= 1 &&
        response.height <= MAX_TERMINAL_PIXEL_DIMENSION &&
        response.width >= 1 &&
        response.width <= MAX_TERMINAL_PIXEL_DIMENSION
      );
    case 'window_18':
      return (
        response.responseClass === 'window_18' &&
        response.height === geometry.rows &&
        response.width === geometry.cols
      );
  }
  return false;
}

function validGeometry(geometry: TerminalResponseGeometry): boolean {
  return (
    Number.isInteger(geometry.cols) &&
    geometry.cols >= 1 &&
    geometry.cols <= MAX_TERMINAL_COLUMNS &&
    Number.isInteger(geometry.rows) &&
    geometry.rows >= 1 &&
    geometry.rows <= MAX_TERMINAL_ROWS
  );
}

/** Attachment-local, bounded, TTL-scoped outstanding-query authorization queue. */
class OutstandingTerminalQueryQueue {
  private readonly profile: TerminalResponseProfile;
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly responseRateLimit: number;
  private readonly responseRateWindowMs: number;
  private readonly now: () => number;
  private readonly onQueueFull?: (event: TerminalQueryQueueFullEvent) => void;
  private readonly onResponseRateLimited?: (event: TerminalResponseRateLimitedEvent) => void;
  private readonly queries: OutstandingTerminalQuery[] = [];
  private readonly responseAttempts: number[] = [];
  private nextId = 1;
  private lastNow = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(configuration: QueueConfiguration) {
    this.profile = configuration.profile;
    this.ttlMs = configuration.ttlMs;
    this.capacity = configuration.capacity;
    this.responseRateLimit = configuration.responseRateLimit;
    this.responseRateWindowMs = configuration.responseRateWindowMs;
    this.now = configuration.now;
    this.onQueueFull = configuration.onQueueFull;
    this.onResponseRateLimited = configuration.onResponseRateLimited;
  }

  get pending(): number {
    return this.queries.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  snapshot(): readonly OutstandingTerminalQuery[] {
    return this.queries.map((query) => ({ ...query }));
  }

  enqueueBatch(queries: readonly TerminalQueryExpectation[]): {
    readonly enqueued: readonly OutstandingTerminalQuery[];
    readonly refused: readonly TerminalQueryExpectation[];
  } {
    if (queries.length === 0) return { enqueued: [], refused: [] };
    if (this.closed) return { enqueued: [], refused: [...queries] };
    const now = this.readNow();
    if (now === null) return { enqueued: [], refused: [...queries] };
    this.pruneAt(now);

    // A stacked query is one terminal action. Admit all of its expected
    // responses or none, so partial capacity cannot create a misleading lease.
    if (this.queries.length + queries.length > this.capacity) {
      this.notifyQueueFull(queries);
      return { enqueued: [], refused: [...queries] };
    }

    const expiresAt = now + this.ttlMs;
    if (!Number.isFinite(expiresAt)) {
      this.close();
      return { enqueued: [], refused: [...queries] };
    }
    const enqueued = queries.map((query) =>
      Object.freeze({
        ...query,
        id: this.nextId++,
        enqueuedAt: now,
        expiresAt,
      }),
    ) as OutstandingTerminalQuery[];
    this.queries.push(...enqueued);
    return { enqueued, refused: [] };
  }

  pruneExpired(): number {
    if (this.closed) return 0;
    const now = this.readNow();
    return now === null ? 0 : this.pruneAt(now);
  }

  consumeResponse(
    bytes: Uint8Array,
    geometry: TerminalResponseGeometry,
  ): TerminalResponseConsumeResult {
    const validated = this.validateResponseAttempt(bytes, geometry);
    if (!validated.accepted) return validated;
    return this.consumeValidatedClassification(validated.classification, geometry);
  }

  /**
   * Consume accounting for an already lease-authorized writer burst. This never
   * grants write authority and intentionally does not spend the lease-independent
   * terminal-response rate budget.
   */
  accountForWriterResponse(
    bytes: Uint8Array,
    geometry: TerminalResponseGeometry,
  ): TerminalResponseConsumeResult {
    if (this.closed) return { accepted: false, reason: 'closed' };
    const now = this.readNow();
    if (now === null) return { accepted: false, reason: 'clock_invalid' };
    this.pruneAt(now);
    return this.consumeClassified(bytes, geometry);
  }

  /**
   * Consume matching response tokens embedded in an already lease-authorized
   * mixed keystroke burst. This method never writes, grants authority, returns
   * replacement bytes, or spends the lease-independent response rate budget.
   */
  accountForWriterBurst(
    bytes: Uint8Array,
    geometry: TerminalResponseGeometry,
  ): TerminalWriterBurstAccountingResult {
    if (this.closed) {
      return {
        inspected: false,
        reason: 'closed',
        candidateCount: 0,
        consumed: [],
      };
    }
    if (bytes.byteLength > MAX_TERMINAL_INPUT_BYTES) {
      return {
        inspected: false,
        reason: 'burst_too_large',
        candidateCount: 0,
        consumed: [],
      };
    }
    const now = this.readNow();
    if (now === null) {
      return {
        inspected: false,
        reason: 'clock_invalid',
        candidateCount: 0,
        consumed: [],
      };
    }
    this.pruneAt(now);
    if (!validGeometry(geometry)) {
      return {
        inspected: false,
        reason: 'invalid_geometry',
        candidateCount: 0,
        consumed: [],
      };
    }

    const spans = findEmbeddedTerminalResponses(bytes).filter((span) =>
      terminalResponseClassEnabled(this.profile, span.classification.responseClass),
    );
    const consumed: AccountedWriterTerminalResponse[] = [];
    for (const span of spans) {
      const result = this.consumeClassification(span.classification, geometry);
      if (!result.accepted) continue;
      consumed.push({
        byteOffset: span.byteOffset,
        byteLength: span.byteLength,
        classification: result.classification,
        query: result.query,
      });
    }
    return {
      inspected: true,
      candidateCount: spans.length,
      consumed,
    };
  }

  async consumeAndWriteResponse(
    bytes: Uint8Array,
    geometry: TerminalResponseGeometry,
    write: (bytes: Uint8Array) => void | Promise<void>,
    isAttachmentLive?: TerminalResponseWriteFence,
  ): Promise<TerminalResponseWriteResult> {
    if (!this.passesWriteFence(isAttachmentLive, 'before_validation')) {
      return { accepted: false, reason: 'closed', consumed: false };
    }

    const validated = this.validateResponseAttempt(bytes, geometry);
    if (!validated.accepted) {
      return { ...validated, consumed: false };
    }
    if (!this.passesWriteFence(isAttachmentLive, 'after_validation')) {
      return {
        accepted: false,
        reason: 'closed',
        consumed: false,
        classification: validated.classification,
      };
    }

    const consumed = this.consumeValidatedClassification(
      validated.classification,
      geometry,
    );
    if (!consumed.accepted) {
      return { ...consumed, consumed: false };
    }

    // No await or queued continuation occurs between atomic consume and the
    // provider write invocation.  The external generation fence is nevertheless
    // checked at the exact boundary so close/replacement/auth/task teardown can
    // never turn a consumed token into an old-provider-PTY write.
    if (!this.passesWriteFence(isAttachmentLive, 'after_consume')) {
      return {
        accepted: false,
        reason: 'closed_after_consume',
        consumed: true,
        classification: consumed.classification,
        query: consumed.query,
      };
    }
    try {
      const pending = write(bytes);
      await pending;
      return consumed;
    } catch (error) {
      return {
        accepted: false,
        reason: 'write_failed',
        consumed: true,
        classification: consumed.classification,
        query: consumed.query,
        error,
      };
    }
  }

  clear(): void {
    this.queries.length = 0;
    this.responseAttempts.length = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clear();
  }

  private consumeClassified(
    bytes: Uint8Array,
    geometry: TerminalResponseGeometry,
  ): TerminalResponseConsumeResult {
    const classification = classifyTerminalResponseBytes(bytes);
    if (classification === null) return { accepted: false, reason: 'invalid_response' };
    return this.consumeClassification(classification, geometry);
  }

  private consumeClassification(
    classification: TerminalResponseClassification,
    geometry: TerminalResponseGeometry,
  ): TerminalResponseConsumeResult {
    const validated = this.validateClassification(classification, geometry);
    if (!validated.accepted) return validated;
    return this.consumeValidatedClassification(classification, geometry);
  }

  private validateResponseAttempt(
    bytes: Uint8Array,
    geometry: TerminalResponseGeometry,
  ): TerminalResponseValidationResult {
    if (this.closed) return { accepted: false, reason: 'closed' };
    const now = this.readNow();
    if (now === null) return { accepted: false, reason: 'clock_invalid' };
    this.pruneAt(now);
    if (!this.consumeResponseRateSlot(now)) {
      return { accepted: false, reason: 'rate_limited' };
    }
    const classification = classifyTerminalResponseBytes(bytes);
    if (classification === null) return { accepted: false, reason: 'invalid_response' };
    return this.validateClassification(classification, geometry);
  }

  private validateClassification(
    classification: TerminalResponseClassification,
    geometry: TerminalResponseGeometry,
  ): TerminalResponseValidationResult {
    if (!terminalResponseClassEnabled(this.profile, classification.responseClass)) {
      return { accepted: false, reason: 'profile_disabled', classification };
    }
    if (!validGeometry(geometry)) {
      return { accepted: false, reason: 'invalid_geometry', classification };
    }

    return { accepted: true, classification };
  }

  private consumeValidatedClassification(
    classification: TerminalResponseClassification,
    geometry: TerminalResponseGeometry,
  ): TerminalResponseConsumeResult {
    const queryIndex = this.queries.findIndex((query) =>
      responseMatchesQuery(classification, query, geometry),
    );
    if (queryIndex < 0) return { accepted: false, reason: 'unmatched', classification };
    const [query] = this.queries.splice(queryIndex, 1);
    if (!query) return { accepted: false, reason: 'unmatched', classification };
    return { accepted: true, classification, query };
  }

  private passesWriteFence(
    fence: TerminalResponseWriteFence | undefined,
    checkpoint: TerminalResponseWriteCheckpoint,
  ): boolean {
    if (this.closed) return false;
    try {
      if (fence?.(checkpoint) === false) {
        this.close();
        return false;
      }
    } catch {
      this.close();
      return false;
    }
    return !this.closed;
  }

  private consumeResponseRateSlot(now: number): boolean {
    let expired = 0;
    while (
      expired < this.responseAttempts.length &&
      now >= (this.responseAttempts[expired] ?? 0) + this.responseRateWindowMs
    ) {
      expired += 1;
    }
    if (expired > 0) this.responseAttempts.splice(0, expired);
    if (this.responseAttempts.length >= this.responseRateLimit) {
      this.notifyRateLimited();
      return false;
    }
    this.responseAttempts.push(now);
    return true;
  }

  private pruneAt(now: number): number {
    const before = this.queries.length;
    let writeIndex = 0;
    for (const query of this.queries) {
      if (now < query.expiresAt) this.queries[writeIndex++] = query;
    }
    this.queries.length = writeIndex;
    return before - writeIndex;
  }

  private readNow(): number | null {
    let now: number;
    try {
      now = this.now();
    } catch {
      this.close();
      return null;
    }
    if (!Number.isFinite(now) || now < this.lastNow) {
      this.close();
      return null;
    }
    this.lastNow = now;
    return now;
  }

  private notifyQueueFull(queries: readonly TerminalQueryExpectation[]): void {
    if (!this.onQueueFull) return;
    try {
      this.onQueueFull({
        capacity: this.capacity,
        pending: this.queries.length,
        requested: queries.length,
        queries: [...queries],
      });
    } catch {
      // Observability must not become a terminal-stream side effect.
    }
  }

  private notifyRateLimited(): void {
    if (!this.onResponseRateLimited) return;
    try {
      this.onResponseRateLimited({
        limit: this.responseRateLimit,
        windowMs: this.responseRateWindowMs,
        attemptsInWindow: this.responseAttempts.length,
      });
    } catch {
      // Observability must not alter authorization state.
    }
  }
}

/**
 * Reusable attachment-local composition used by TerminalGateway.
 *
 * Integration order is load-bearing: call `observeOutput(raw)` synchronously
 * before making that same raw chunk eligible for browser delivery. The method
 * never returns replacement bytes and never owns delivery.
 */
export class TerminalQueryObserver {
  private readonly parser: IncrementalTerminalQueryParser;
  private readonly queue: OutstandingTerminalQueryQueue;

  constructor(options: TerminalQueryObserverOptions = {}) {
    const profile = TerminalResponseProfileSchema.parse(
      options.profile ?? XTERM_5_5_0_RESPONSE_PROFILE,
    );
    const configuration: QueueConfiguration = {
      profile,
      ttlMs: boundedFinite(
        'terminal query TTL',
        options.ttlMs,
        DEFAULT_TERMINAL_QUERY_TTL_MS,
        MAX_TERMINAL_QUERY_TTL_MS,
      ),
      capacity: boundedInteger(
        'terminal query capacity',
        options.capacity,
        DEFAULT_TERMINAL_QUERY_CAPACITY,
        MAX_TERMINAL_QUERY_CAPACITY,
      ),
      responseRateLimit: boundedInteger(
        'terminal response rate limit',
        options.responseRateLimit,
        DEFAULT_TERMINAL_RESPONSE_RATE_LIMIT,
        MAX_TERMINAL_RESPONSE_RATE_LIMIT,
      ),
      responseRateWindowMs: boundedFinite(
        'terminal response rate window',
        options.responseRateWindowMs,
        DEFAULT_TERMINAL_RESPONSE_RATE_WINDOW_MS,
        MAX_TERMINAL_RESPONSE_RATE_WINDOW_MS,
      ),
      now: options.now ?? (() => performance.now()),
      onQueueFull: options.onQueueFull,
      onResponseRateLimited: options.onResponseRateLimited,
    };
    this.parser = new IncrementalTerminalQueryParser(profile);
    this.queue = new OutstandingTerminalQueryQueue(configuration);
  }

  get pending(): number {
    return this.queue.pending;
  }

  get carryBytes(): number {
    return this.parser.carryBytes;
  }

  get isClosed(): boolean {
    return this.queue.isClosed;
  }

  snapshot(): readonly OutstandingTerminalQuery[] {
    return this.queue.snapshot();
  }

  observeOutput(bytes: Uint8Array): TerminalQueryObservation {
    if (this.queue.isClosed) {
      return {
        recognized: [],
        enqueued: [],
        refused: [],
        observations: [],
        pending: 0,
      };
    }

    const recognized: TerminalQueryExpectation[] = [];
    const enqueued: OutstandingTerminalQuery[] = [];
    const refused: TerminalQueryExpectation[] = [];
    const observations: Array<{
      readonly query: TerminalQueryExpectation;
      readonly rawBytes: Uint8Array;
      readonly queryId: number | null;
      readonly admitted: boolean;
    }> = [];
    for (const batch of this.parser.observe(bytes)) {
      recognized.push(...batch.queries);
      const outcome = this.queue.enqueueBatch(batch.queries);
      enqueued.push(...outcome.enqueued);
      refused.push(...outcome.refused);
      if (outcome.enqueued.length > 0) {
        for (const query of outcome.enqueued) {
          observations.push({
            query,
            rawBytes: new Uint8Array(batch.rawBytes),
            queryId: query.id,
            admitted: true,
          });
        }
      } else {
        for (const query of outcome.refused) {
          observations.push({
            query,
            rawBytes: new Uint8Array(batch.rawBytes),
            queryId: null,
            admitted: false,
          });
        }
      }
    }
    return {
      recognized,
      enqueued,
      refused,
      observations,
      pending: this.queue.pending,
    };
  }

  consumeResponse(
    bytes: Uint8Array,
    geometry: TerminalResponseGeometry,
  ): TerminalResponseConsumeResult {
    return this.queue.consumeResponse(bytes, geometry);
  }

  accountForWriterResponse(
    bytes: Uint8Array,
    geometry: TerminalResponseGeometry,
  ): TerminalResponseConsumeResult {
    return this.queue.accountForWriterResponse(bytes, geometry);
  }

  /**
   * Accounting-only companion for the lease-gated keystroke path. The caller
   * must subsequently write its original `bytes` object once and unchanged.
   */
  accountForWriterBurst(
    bytes: Uint8Array,
    geometry: TerminalResponseGeometry,
  ): TerminalWriterBurstAccountingResult {
    return this.queue.accountForWriterBurst(bytes, geometry);
  }

  consumeAndWriteResponse(
    bytes: Uint8Array,
    geometry: TerminalResponseGeometry,
    write: (bytes: Uint8Array) => void | Promise<void>,
    isAttachmentLive?: TerminalResponseWriteFence,
  ): Promise<TerminalResponseWriteResult> {
    return this.queue.consumeAndWriteResponse(
      bytes,
      geometry,
      write,
      isAttachmentLive,
    );
  }

  pruneExpired(): number {
    return this.queue.pruneExpired();
  }

  clear(): void {
    this.parser.clear();
    this.queue.clear();
  }

  close(): void {
    this.queue.close();
    this.parser.clear();
  }
}
