import { z } from 'zod';

export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;

const CANONICAL_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Return the decoded byte length without decoding or applying text semantics. */
export function canonicalBase64DecodedLength(value: string): number | null {
  if (!CANONICAL_BASE64_RE.test(value)) return null;
  if (value.length === 0) return 0;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (value.endsWith('==')) {
    const finalSextet = alphabet.indexOf(value[value.length - 3] ?? '');
    if ((finalSextet & 0x0f) !== 0) return null;
  } else if (value.endsWith('=')) {
    const finalSextet = alphabet.indexOf(value[value.length - 2] ?? '');
    if ((finalSextet & 0x03) !== 0) return null;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/**
 * Decode already-validated canonical base64 into opaque bytes.
 *
 * This deliberately has no UTF-8/string conversion: `0x00`, high bytes, and
 * legacy mouse input retain their exact byte values.
 */
export function decodeCanonicalBase64Bytes(value: string): Uint8Array {
  const decodedLength = canonicalBase64DecodedLength(value);
  if (decodedLength === null) {
    throw new TypeError('Expected canonical base64');
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const output = new Uint8Array(decodedLength);
  let outputOffset = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = alphabet.indexOf(value[offset] ?? '');
    const b = alphabet.indexOf(value[offset + 1] ?? '');
    const c = value[offset + 2] === '=' ? 0 : alphabet.indexOf(value[offset + 2] ?? '');
    const d = value[offset + 3] === '=' ? 0 : alphabet.indexOf(value[offset + 3] ?? '');
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputOffset < decodedLength) output[outputOffset++] = (packed >>> 16) & 0xff;
    if (outputOffset < decodedLength) output[outputOffset++] = (packed >>> 8) & 0xff;
    if (outputOffset < decodedLength) output[outputOffset++] = packed & 0xff;
  }
  return output;
}

/** Build a canonical-base64 schema whose payload stays byte-opaque. */
export function createOpaqueTerminalBase64Schema(options: {
  readonly minBytes?: number;
  readonly maxBytes: number;
}): z.ZodType<string> {
  const minBytes = options.minBytes ?? 0;
  const maxEncodedLength = Math.ceil(options.maxBytes / 3) * 4;
  return z.string().superRefine((value, context) => {
    if (value.length > maxEncodedLength) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'string',
        maximum: maxEncodedLength,
        inclusive: true,
        message: `Encoded payload exceeds the ${options.maxBytes}-byte limit`,
      });
      return;
    }
    const decodedLength = canonicalBase64DecodedLength(value);
    if (decodedLength === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected canonical base64 without whitespace or URL-safe alphabet',
      });
      return;
    }
    if (decodedLength < minBytes || decodedLength > options.maxBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Decoded payload must contain ${minBytes}..${options.maxBytes} bytes`,
      });
    }
  });
}

/** Human input and `onBinary` data are bytes, never implicit UTF-8 text. */
export const OpaqueTerminalInputBase64Schema = createOpaqueTerminalBase64Schema({
  minBytes: 1,
  maxBytes: MAX_TERMINAL_INPUT_BYTES,
});
