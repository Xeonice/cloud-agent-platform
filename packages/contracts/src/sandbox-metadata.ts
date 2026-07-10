import { z } from './zod-instance.js';

export const SANDBOX_METADATA_PATH = '/etc/cap/sandbox-metadata.json';
export const SANDBOX_METADATA_SCHEMA_VERSION = 1 as const;

export const SandboxDependencyIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'must be a lowercase dependency id');

const MOVING_VERSION_TAGS = new Set([
  'alpha',
  'beta',
  'canary',
  'dev',
  'latest',
  'next',
  'nightly',
  'rc',
  'stable',
]);

const EXACT_SEMVER_PATTERN =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PARTIAL_OR_WILDCARD_SEMVER_PATTERN =
  /^v?(?:\d+|x|\*)(?:\.(?:\d+|x|\*)){0,2}$/i;
const COMPARATOR_PATTERN = /(?:^|\s)[<>]=?|(?:^|\s)=/;
const HYPHEN_RANGE_PATTERN =
  /(?:^|\s)v?\d+(?:\.\d+){0,2}\s+-\s+v?\d+(?:\.\d+){0,2}(?:$|\s)/;

function isMovingVersionSelector(value: string): boolean {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();

  if (MOVING_VERSION_TAGS.has(lower)) return true;
  if (EXACT_SEMVER_PATTERN.test(normalized)) return false;

  return (
    PARTIAL_OR_WILDCARD_SEMVER_PATTERN.test(normalized) ||
    normalized.includes('||') ||
    normalized.includes('^') ||
    normalized.includes('~') ||
    COMPARATOR_PATTERN.test(normalized) ||
    HYPHEN_RANGE_PATTERN.test(normalized)
  );
}

const ExactVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !isMovingVersionSelector(value), {
    message: 'must be an exact version, not a moving selector',
  });

export const SandboxMetadataSchema = z.object({
  schemaVersion: z.literal(SANDBOX_METADATA_SCHEMA_VERSION),
  sandboxVersion: ExactVersionSchema,
  dependencies: z
    .record(SandboxDependencyIdSchema, ExactVersionSchema)
    .refine((dependencies) => Object.keys(dependencies).length > 0, {
      message: 'must declare at least one dependency',
    }),
});

export type SandboxMetadata = z.infer<typeof SandboxMetadataSchema>;

export function parseSandboxMetadataText(text: string): SandboxMetadata {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `invalid sandbox metadata JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertNoDuplicateDependencyIds(text);
  return SandboxMetadataSchema.parse(value);
}

/**
 * JSON.parse necessarily collapses duplicate object keys. Walk the already
 * syntax-validated JSON text so dependency ids are compared before that loss.
 * Decoding each key with JSON.parse also catches escaped aliases such as
 * `"co\\u0064ex"` and `"codex"` as the same dependency id.
 */
function assertNoDuplicateDependencyIds(text: string): void {
  let offset = 0;

  const skipWhitespace = () => {
    while (/\s/.test(text[offset] ?? '')) offset += 1;
  };

  const readString = (): string => {
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '\\') {
        offset += 2;
        continue;
      }
      offset += 1;
      if (character === '"') break;
    }
    return JSON.parse(text.slice(start, offset)) as string;
  };

  const readScalar = () => {
    while (offset < text.length && !/[\s,\]}]/.test(text[offset] ?? '')) {
      offset += 1;
    }
  };

  const readValue = (path: readonly string[]): void => {
    skipWhitespace();
    const character = text[offset];
    if (character === '{') {
      readObject(path);
      return;
    }
    if (character === '[') {
      readArray(path);
      return;
    }
    if (character === '"') {
      readString();
      return;
    }
    readScalar();
  };

  const readObject = (path: readonly string[]): void => {
    offset += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (text[offset] === '}') {
      offset += 1;
      return;
    }

    while (offset < text.length) {
      skipWhitespace();
      const key = readString();
      if (path.length === 1 && path[0] === 'dependencies' && keys.has(key)) {
        throw new Error(`duplicate sandbox dependency id: ${key}`);
      }
      keys.add(key);
      skipWhitespace();
      offset += 1; // colon; JSON.parse above already proved the syntax is valid.
      readValue([...path, key]);
      skipWhitespace();
      if (text[offset] === '}') {
        offset += 1;
        return;
      }
      offset += 1; // comma
    }
  };

  const readArray = (path: readonly string[]): void => {
    offset += 1;
    skipWhitespace();
    if (text[offset] === ']') {
      offset += 1;
      return;
    }

    while (offset < text.length) {
      readValue(path);
      skipWhitespace();
      if (text[offset] === ']') {
        offset += 1;
        return;
      }
      offset += 1; // comma
    }
  };

  readValue([]);
}
