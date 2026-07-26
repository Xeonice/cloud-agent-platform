import { z } from 'zod';
import { FRAME_CHANNEL } from './ws-frames.js';
import {
  canonicalBase64DecodedLength,
  createOpaqueTerminalBase64Schema,
  decodeCanonicalBase64Bytes,
} from './terminal-bytes.js';

/** Current CAP live-terminal handshake version. */
export const TERMINAL_PROTOCOL_VERSION = 1 as const;

/** Hard wire bounds shared by attach, resize, and authoritative geometry frames. */
export const MAX_TERMINAL_COLUMNS = 1_000 as const;
export const MAX_TERMINAL_ROWS = 1_000 as const;
export const MAX_TERMINAL_PIXEL_DIMENSION = 1_000_000 as const;
export const MAX_TERMINAL_RESPONSE_BYTES = 4 * 1024;

export const TerminalProtocolVersionSchema = z.number().int().min(1).max(65_535);
export const TerminalColumnCountSchema = z.number().int().min(1).max(MAX_TERMINAL_COLUMNS);
export const TerminalRowCountSchema = z.number().int().min(1).max(MAX_TERMINAL_ROWS);

export const TerminalResponseClassSchema = z.enum([
  'da1',
  'da2',
  'dsr_status',
  'cpr',
  'private_cpr',
  'decrqm_ansi',
  'decrqm_private',
  'decrqss',
  'osc_4',
  'osc_10',
  'osc_11',
  'osc_12',
  'window_14',
  'window_16',
  'window_18',
]);
export type TerminalResponseClass = z.infer<typeof TerminalResponseClassSchema>;

const TerminalResponseAddonSchema = z
  .object({
    name: z.string().min(1).max(128),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    configuration: z.string().min(1).max(256).optional(),
  })
  .strict();

export const TerminalResponseProfileDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    xtermVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    termName: z.string().min(1).max(64),
    disableStdin: z.boolean(),
    windowOptions: z
      .object({
        getWinSizePixels: z.boolean(),
        getCellSizePixels: z.boolean(),
        getWinSizeChars: z.boolean(),
      })
      .strict(),
    responseAffectingAddons: z.array(TerminalResponseAddonSchema).max(16),
    responseClasses: z.array(TerminalResponseClassSchema).min(1).max(32),
  })
  .strict()
  .superRefine((profile, context) => {
    const addonNames = profile.responseAffectingAddons.map((addon) => addon.name);
    if (new Set(addonNames).size !== addonNames.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Addon names must be unique' });
    }
    if (new Set(profile.responseClasses).size !== profile.responseClasses.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Response classes must be unique',
      });
    }
    const conditionalWindows = [
      ['window_14', profile.windowOptions.getWinSizePixels],
      ['window_16', profile.windowOptions.getCellSizePixels],
      ['window_18', profile.windowOptions.getWinSizeChars],
    ] as const;
    for (const [responseClass, enabled] of conditionalWindows) {
      if (profile.responseClasses.includes(responseClass) !== enabled) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['responseClasses'],
          message: `${responseClass} must exactly match its windowOptions gate`,
        });
      }
    }
  });
export type TerminalResponseProfileDescriptor = z.infer<
  typeof TerminalResponseProfileDescriptorSchema
>;

const TERMINAL_RESPONSE_PROFILE_ID_RE = /^xterm-response-v\d+-sha256-[0-9a-f]{64}$/;
export const TerminalResponseProfileIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(TERMINAL_RESPONSE_PROFILE_ID_RE);

export const TerminalResponseProfileSchema = z
  .object({
    descriptor: TerminalResponseProfileDescriptorSchema,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    id: TerminalResponseProfileIdSchema,
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.id !== `xterm-response-v${profile.descriptor.schemaVersion}-sha256-${profile.fingerprint}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: 'Profile id must contain its exact schema version and fingerprint',
      });
    }
  });
export type TerminalResponseProfile = z.infer<typeof TerminalResponseProfileSchema>;

/**
 * Exact response-affecting production Terminal wrapper inputs for xterm 5.5.0.
 * The fingerprint is source-validated in focused contract tests and the root
 * verify gate resolves the UI package's exact installed versions. Window
 * reports are explicitly disabled by the wrapper's canonical source config.
 */
export const XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR: TerminalResponseProfileDescriptor = {
  schemaVersion: 1,
  xtermVersion: '5.5.0',
  termName: 'xterm',
  disableStdin: false,
  windowOptions: {
    getWinSizePixels: false,
    getCellSizePixels: false,
    getWinSizeChars: false,
  },
  responseAffectingAddons: [
    {
      name: '@xterm/addon-unicode11',
      version: '0.8.0',
      configuration: 'activeVersion=11',
    },
  ],
  responseClasses: [
    'da1',
    'da2',
    'dsr_status',
    'cpr',
    'private_cpr',
    'decrqm_ansi',
    'decrqm_private',
    'decrqss',
    'osc_4',
    'osc_10',
    'osc_11',
    'osc_12',
  ],
};

export const XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT_SOURCE = JSON.stringify(
  XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR,
);

// Validated against the exact JSON source above by terminal-attachment-frames.test.mjs.
export const XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT =
  'e491643e62538a297c8e2d03ec0396657b5575d8e9f56f56c5bdf44a0e4afd82' as const;
export const XTERM_5_5_0_RESPONSE_PROFILE_ID =
  `xterm-response-v1-sha256-${XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT}` as const;

export const XTERM_5_5_0_RESPONSE_PROFILE: TerminalResponseProfile = {
  descriptor: XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR,
  fingerprint: XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT,
  id: XTERM_5_5_0_RESPONSE_PROFILE_ID,
};

/**
 * Validation gate for the one profile this coordinated API/Web build knows.
 * A syntactically valid but drifted descriptor/fingerprint is not negotiable.
 */
export const Xterm550ResponseProfileSchema = TerminalResponseProfileSchema.superRefine(
  (profile, context) => {
    if (
      profile.id !== XTERM_5_5_0_RESPONSE_PROFILE_ID ||
      profile.fingerprint !== XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT ||
      JSON.stringify(profile.descriptor) !== XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT_SOURCE
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Response profile does not match the validated xterm 5.5.0 fingerprint inputs',
      });
    }
  },
);

export type TerminalResponseClassification =
  | { readonly responseClass: 'da1' | 'da2' | 'dsr_status' }
  | { readonly responseClass: 'cpr' | 'private_cpr'; readonly row: number; readonly column: number }
  | {
      readonly responseClass: 'decrqm_ansi' | 'decrqm_private';
      readonly mode: number;
      readonly status: 0 | 1 | 2 | 3 | 4;
    }
  | {
      readonly responseClass: 'decrqss';
      readonly subtype: 'sgr' | 'margins' | 'cursor_style' | 'protection' | 'conformance' | 'unknown';
      readonly positive: boolean;
    }
  | {
      readonly responseClass: 'osc_4';
      readonly colorIndex: number;
    }
  | { readonly responseClass: 'osc_10' | 'osc_11' | 'osc_12' }
  | {
      readonly responseClass: 'window_14' | 'window_16' | 'window_18';
      readonly height: number;
      readonly width: number;
    };

function asciiBytes(bytes: Uint8Array): string | null {
  let value = '';
  for (const byte of bytes) {
    if (byte > 0x7f) return null;
    value += String.fromCharCode(byte);
  }
  return value;
}

function parseBoundedPositive(value: string, maximum: number): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

/**
 * Classify exactly one complete response emitted by the pinned xterm profile.
 * Concatenated, prefixed, suffixed, non-ASCII, or malformed responses return
 * null. This finite grammar is not an authorization decision; the Gateway must
 * still correlate the result with a live outstanding query.
 */
export function classifyTerminalResponseBytes(
  bytes: Uint8Array,
): TerminalResponseClassification | null {
  /* eslint-disable no-control-regex -- terminal response grammar must match the ESC control byte. */
  if (bytes.length === 0 || bytes.length > MAX_TERMINAL_RESPONSE_BYTES) return null;
  const value = asciiBytes(bytes);
  if (value === null) return null;

  if (value === '\x1b[?1;2c') return { responseClass: 'da1' };
  if (value === '\x1b[>0;276;0c') return { responseClass: 'da2' };
  if (value === '\x1b[0n') return { responseClass: 'dsr_status' };

  const cursor = /^\x1b\[(\?)?([1-9]\d*);([1-9]\d*)R$/.exec(value);
  if (cursor) {
    const row = parseBoundedPositive(cursor[2] ?? '', MAX_TERMINAL_ROWS);
    const column = parseBoundedPositive(cursor[3] ?? '', MAX_TERMINAL_COLUMNS);
    if (row === null || column === null) return null;
    return {
      responseClass: cursor[1] === '?' ? 'private_cpr' : 'cpr',
      row,
      column,
    };
  }

  const mode = /^\x1b\[(\?)?(0|[1-9]\d{0,5});([0-4])\$y$/.exec(value);
  if (mode) {
    const parsedMode = Number(mode[2]);
    if (!Number.isSafeInteger(parsedMode)) return null;
    return {
      responseClass: mode[1] === '?' ? 'decrqm_private' : 'decrqm_ansi',
      mode: parsedMode,
      status: Number(mode[3]) as 0 | 1 | 2 | 3 | 4,
    };
  }

  if (value === '\x1bP0$r\x1b\\') {
    return { responseClass: 'decrqss', subtype: 'unknown', positive: false };
  }
  const statusString = /^\x1bP1\$r(.*)\x1b\\$/.exec(value);
  if (statusString) {
    const payload = statusString[1] ?? '';
    if (payload === '0m') {
      return { responseClass: 'decrqss', subtype: 'sgr', positive: true };
    }
    if (/^[1-6] q$/.test(payload)) {
      return { responseClass: 'decrqss', subtype: 'cursor_style', positive: true };
    }
    if (/^[01]"q$/.test(payload)) {
      return { responseClass: 'decrqss', subtype: 'protection', positive: true };
    }
    if (payload === '61;1"p') {
      return { responseClass: 'decrqss', subtype: 'conformance', positive: true };
    }
    const margins = /^([1-9]\d*);([1-9]\d*)r$/.exec(payload);
    if (margins) {
      const top = parseBoundedPositive(margins[1] ?? '', MAX_TERMINAL_ROWS);
      const bottom = parseBoundedPositive(margins[2] ?? '', MAX_TERMINAL_ROWS);
      if (top !== null && bottom !== null && top <= bottom) {
        return { responseClass: 'decrqss', subtype: 'margins', positive: true };
      }
    }
    return null;
  }

  const color = /^\x1b\](4;(0|[1-9]\d{0,2})|10|11|12);rgb:([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{4})\x1b\\$/.exec(
    value,
  );
  if (color) {
    const command = color[1] ?? '';
    if (command.startsWith('4;')) {
      const colorIndex = Number(color[2]);
      if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex > 255) return null;
      return { responseClass: 'osc_4', colorIndex };
    }
    return { responseClass: `osc_${command}` as 'osc_10' | 'osc_11' | 'osc_12' };
  }

  const windowReport = /^\x1b\[(4|6|8);([1-9]\d*);([1-9]\d*)t$/.exec(value);
  if (windowReport) {
    const report = windowReport[1];
    const maximum = report === '8' ? Math.max(MAX_TERMINAL_COLUMNS, MAX_TERMINAL_ROWS) : MAX_TERMINAL_PIXEL_DIMENSION;
    const height = parseBoundedPositive(windowReport[2] ?? '', maximum);
    const width = parseBoundedPositive(windowReport[3] ?? '', maximum);
    if (height === null || width === null) return null;
    return {
      responseClass: report === '4' ? 'window_14' : report === '6' ? 'window_16' : 'window_18',
      height,
      width,
    };
  }

  return null;
  /* eslint-enable no-control-regex */
}

export function terminalResponseClassEnabled(
  profile: TerminalResponseProfile,
  responseClass: TerminalResponseClass,
): boolean {
  if (profile.descriptor.responseClasses.includes(responseClass)) return true;
  if (responseClass === 'window_14') return profile.descriptor.windowOptions.getWinSizePixels;
  if (responseClass === 'window_16') return profile.descriptor.windowOptions.getCellSizePixels;
  if (responseClass === 'window_18') return profile.descriptor.windowOptions.getWinSizeChars;
  return false;
}

export function createTerminalResponseBase64Schema(
  profile: TerminalResponseProfile,
): z.ZodType<string> {
  const validatedProfile = TerminalResponseProfileSchema.parse(profile);
  return createOpaqueTerminalBase64Schema({
    minBytes: 1,
    maxBytes: MAX_TERMINAL_RESPONSE_BYTES,
  }).superRefine((value, context) => {
    if (value.length > Math.ceil(MAX_TERMINAL_RESPONSE_BYTES / 3) * 4) return;
    const decodedLength = canonicalBase64DecodedLength(value);
    if (
      decodedLength === null ||
      decodedLength < 1 ||
      decodedLength > MAX_TERMINAL_RESPONSE_BYTES
    ) {
      return;
    }
    const classification = classifyTerminalResponseBytes(decodeCanonicalBase64Bytes(value));
    if (
      classification === null ||
      !terminalResponseClassEnabled(validatedProfile, classification.responseClass)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected one complete response enabled by the negotiated profile',
      });
    }
  });
}

export const TerminalResponseBase64Schema = createTerminalResponseBase64Schema(
  XTERM_5_5_0_RESPONSE_PROFILE,
);

/** Client -> server: consume this socket's sole attach attempt. */
export const TerminalAttachFrameSchema = z
  .object({
    channel: z.literal(FRAME_CHANNEL.CONTROL),
    type: z.literal('terminal_attach'),
    protocolVersion: TerminalProtocolVersionSchema,
    responseProfileId: TerminalResponseProfileIdSchema,
    cols: TerminalColumnCountSchema,
    rows: TerminalRowCountSchema,
  })
  .strict();
export type TerminalAttachFrame = z.infer<typeof TerminalAttachFrameSchema>;

/**
 * Build the exact attach frame emitted by the current coordinated Web build.
 * Rollout verification imports this production source of truth instead of
 * copying the current protocol/profile fingerprint into a canary fixture.
 */
export function createCurrentTerminalAttachFrame(
  cols: number,
  rows: number,
): TerminalAttachFrame {
  return TerminalAttachFrameSchema.parse({
    channel: FRAME_CHANNEL.CONTROL,
    type: 'terminal_attach',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
    cols,
    rows,
  });
}

const TerminalAttachmentStateBaseSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('terminal_attachment_state'),
  protocolVersion: z.literal(TERMINAL_PROTOCOL_VERSION),
  cols: TerminalColumnCountSchema,
  rows: TerminalRowCountSchema,
});

export const TerminalAttachmentStateFrameSchema = z.union([
  TerminalAttachmentStateBaseSchema.extend({ state: z.literal('attaching') }).strict(),
  TerminalAttachmentStateBaseSchema.extend({ state: z.literal('ready') }).strict(),
  TerminalAttachmentStateBaseSchema.extend({
    state: z.literal('unavailable'),
    reason: z.enum([
      'session_absent',
      'session_indeterminate',
      'viewer_limit',
      'provider_unavailable',
    ]),
    reloadRequired: z.literal(false),
  }).strict(),
  TerminalAttachmentStateBaseSchema.extend({
    state: z.literal('failed'),
    reason: z.enum(['protocol_mismatch', 'response_profile_mismatch']),
    reloadRequired: z.literal(true),
  }).strict(),
  TerminalAttachmentStateBaseSchema.extend({
    state: z.literal('failed'),
    reason: z.enum(['provider_failed', 'attach_timeout', 'transport_closed', 'internal_error']),
    reloadRequired: z.literal(false),
  }).strict(),
]);
export type TerminalAttachmentStateFrame = z.infer<typeof TerminalAttachmentStateFrameSchema>;

/** Server -> clients: the task's current writer-authoritative grid. */
export const TerminalGeometryFrameSchema = z
  .object({
    channel: z.literal(FRAME_CHANNEL.CONTROL),
    type: z.literal('terminal_geometry'),
    protocolVersion: z.literal(TERMINAL_PROTOCOL_VERSION),
    cols: TerminalColumnCountSchema,
    rows: TerminalRowCountSchema,
  })
  .strict();
export type TerminalGeometryFrame = z.infer<typeof TerminalGeometryFrameSchema>;

/**
 * Client -> server: exactly one automatic response for this WebSocket's viewer
 * PTY. No task/session/attachment id is accepted, so this frame cannot retarget
 * the immutable socket binding. Outstanding-query correlation remains required.
 */
export const TerminalResponseFrameSchema = z
  .object({
    channel: z.literal(FRAME_CHANNEL.CONTROL),
    type: z.literal('terminal_response'),
    protocolVersion: z.literal(TERMINAL_PROTOCOL_VERSION),
    data: TerminalResponseBase64Schema,
  })
  .strict();
export type TerminalResponseFrame = z.infer<typeof TerminalResponseFrameSchema>;

/** Existing lease-gated writer resize, now bounded by the native-terminal grid contract. */
export const ResizeFrameSchema = z
  .object({
    channel: z.literal(FRAME_CHANNEL.CONTROL),
    type: z.literal('resize'),
    cols: TerminalColumnCountSchema,
    rows: TerminalRowCountSchema,
  })
  .strict();
export type ResizeFrame = z.infer<typeof ResizeFrameSchema>;

export type TerminalAttachNegotiationFailureFrame = Extract<
  TerminalAttachmentStateFrame,
  { readonly state: 'failed'; readonly reloadRequired: true }
>;

export type TerminalAttachNegotiation =
  | { readonly ok: true; readonly frame: TerminalAttachFrame }
  | {
      readonly ok: false;
      readonly frame: TerminalAttachNegotiationFailureFrame;
    };

/**
 * Pure pre-open negotiation. Callers must run this before any provider probe or
 * PTY open; unknown protocol/profile inputs receive an explicit reload result.
 */
export function negotiateTerminalAttach(frame: TerminalAttachFrame): TerminalAttachNegotiation {
  const common = {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'terminal_attachment_state' as const,
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    cols: frame.cols,
    rows: frame.rows,
  };
  if (frame.protocolVersion !== TERMINAL_PROTOCOL_VERSION) {
    return {
      ok: false,
      frame: {
        ...common,
        state: 'failed',
        reason: 'protocol_mismatch',
        reloadRequired: true,
      },
    };
  }
  if (frame.responseProfileId !== XTERM_5_5_0_RESPONSE_PROFILE_ID) {
    return {
      ok: false,
      frame: {
        ...common,
        state: 'failed',
        reason: 'response_profile_mismatch',
        reloadRequired: true,
      },
    };
  }
  return { ok: true, frame };
}
