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

function isMovingVersionSelector(value) {
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

export function normalizeExactSandboxVersionValue(value, label = 'version') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be non-empty`);
  }
  const normalized = value.trim();
  if (normalized.length > 256) {
    throw new Error(`${label} must be at most 256 characters`);
  }
  if (isMovingVersionSelector(normalized)) {
    throw new Error(`${label} must be an exact version, not a moving selector`);
  }
  return normalized;
}
