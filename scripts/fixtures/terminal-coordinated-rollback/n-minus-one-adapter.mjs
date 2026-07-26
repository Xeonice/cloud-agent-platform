import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const manifestUrl = new URL('./n-minus-one.json', import.meta.url);
const manifestValue = JSON.parse(readFileSync(manifestUrl, 'utf8'));

function ownKeysExactly(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertManifest(value) {
  if (!ownKeysExactly(value, ['buildId', 'fixtureSchemaVersion', 'provenance', 'wire'])) {
    throw new Error('N-1 terminal fixture has an unexpected top-level shape');
  }
  if (
    value.fixtureSchemaVersion !== 1 ||
    typeof value.buildId !== 'string' ||
    value.provenance?.kind !== 'versioned-compatibility-fixture' ||
    value.provenance?.historicalReleaseArtifact !== false ||
    value.wire?.protocolVersion !== 1
  ) {
    throw new Error('N-1 terminal fixture provenance or version is invalid');
  }
  const profile = value.wire.responseProfile;
  if (!ownKeysExactly(profile, ['descriptor', 'fingerprint', 'id'])) {
    throw new Error('N-1 terminal response profile shape is invalid');
  }
  const source = JSON.stringify(profile.descriptor);
  const fingerprint = createHash('sha256').update(source).digest('hex');
  const expectedId = `xterm-response-v${profile.descriptor?.schemaVersion}-sha256-${fingerprint}`;
  if (profile.fingerprint !== fingerprint || profile.id !== expectedId) {
    throw new Error('N-1 terminal response profile fingerprint is not canonical');
  }
  return value;
}

export const N_MINUS_ONE_TERMINAL_BUILD = Object.freeze(assertManifest(manifestValue));

function boundedGeometry(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000;
}

/** Parse the complete N-1 Web attach wire; unknown fields fail closed. */
export function parseNMinusOneTerminalAttachFrame(value) {
  const keys = ['channel', 'cols', 'protocolVersion', 'responseProfileId', 'rows', 'type'];
  if (
    !ownKeysExactly(value, keys) ||
    value.channel !== 'control' ||
    value.type !== 'terminal_attach' ||
    !Number.isSafeInteger(value.protocolVersion) ||
    value.protocolVersion < 1 ||
    value.protocolVersion > 65_535 ||
    typeof value.responseProfileId !== 'string' ||
    !/^xterm-response-v\d+-sha256-[0-9a-f]{64}$/.test(value.responseProfileId) ||
    !boundedGeometry(value.cols) ||
    !boundedGeometry(value.rows)
  ) {
    throw new Error('Invalid N-1 terminal_attach frame');
  }
  return Object.freeze({ ...value });
}

/** The independent wire builder shipped by the versioned N-1 Web fixture. */
export function createNMinusOneTerminalAttachFrame(cols, rows) {
  return parseNMinusOneTerminalAttachFrame({
    channel: 'control',
    type: 'terminal_attach',
    protocolVersion: N_MINUS_ONE_TERMINAL_BUILD.wire.protocolVersion,
    responseProfileId: N_MINUS_ONE_TERMINAL_BUILD.wire.responseProfile.id,
    cols,
    rows,
  });
}

/**
 * Independent N-1 API negotiation. An accepted frame may be handed to the
 * stable Gateway core by the harness; a mismatch is returned before delegation.
 */
export function negotiateNMinusOneTerminalAttach(value) {
  const frame = parseNMinusOneTerminalAttachFrame(value);
  const common = {
    channel: 'control',
    type: 'terminal_attachment_state',
    protocolVersion: N_MINUS_ONE_TERMINAL_BUILD.wire.protocolVersion,
    cols: frame.cols,
    rows: frame.rows,
  };
  if (frame.protocolVersion !== N_MINUS_ONE_TERMINAL_BUILD.wire.protocolVersion) {
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
  if (frame.responseProfileId !== N_MINUS_ONE_TERMINAL_BUILD.wire.responseProfile.id) {
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
