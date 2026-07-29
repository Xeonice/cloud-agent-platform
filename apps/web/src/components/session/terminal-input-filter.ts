import {
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_RESPONSE_BYTES,
  XTERM_5_5_0_RESPONSE_PROFILE,
  classifyTerminalResponseBytes,
  terminalResponseClassEnabled,
} from "@cap-console/contracts";

const ESC = 0x1b;
const encoder = new TextEncoder();

/** `onData` is Unicode text and therefore enters the PTY as explicit UTF-8. */
export function terminalDataToBytes(data: string): Uint8Array {
  return encoder.encode(data);
}

/**
 * xterm's `onBinary` value is a byte string, not Unicode text. Preserve every
 * code unit's low 8 bits and deliberately avoid a UTF-8 round trip.
 */
export function terminalBinaryStringToBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    bytes[index] = data.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/**
 * Losslessly tokenize one complete `onData` burst into profile responses.
 *
 * The result is non-null only when every byte belongs to one or more complete,
 * enabled responses from the pinned production xterm profile. Any prefix,
 * suffix, interstitial human input, incomplete sequence, disabled response, or
 * non-ASCII ambiguity rejects the entire classification. Callers then forward
 * the original UTF-8 bytes through the normal lease-gated keystroke path.
 */
export function tokenizeTerminalResponseBurst(
  data: string,
): readonly Uint8Array[] | null {
  const bytes = terminalDataToBytes(data);
  if (bytes.length === 0 || bytes.length > MAX_TERMINAL_INPUT_BYTES) return null;

  const responses: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    // Every response emitted by the pinned xterm wrapper uses the 7-bit ESC
    // form, even when the originating query used a C1 control form.
    if (bytes[offset] !== ESC) return null;

    const maximumEnd = Math.min(
      bytes.length,
      offset + MAX_TERMINAL_RESPONSE_BYTES,
    );
    let matched: Uint8Array | null = null;
    for (let end = offset + 1; end <= maximumEnd; end += 1) {
      const candidate = bytes.slice(offset, end);
      const classification = classifyTerminalResponseBytes(candidate);
      if (
        classification &&
        terminalResponseClassEnabled(
          XTERM_5_5_0_RESPONSE_PROFILE,
          classification.responseClass,
        )
      ) {
        matched = candidate;
        break;
      }
    }

    if (!matched) return null;
    responses.push(matched);
    offset += matched.length;
  }

  return responses.length > 0 ? responses : null;
}
