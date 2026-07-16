import { z } from 'zod';

/** Conservative upper bound for a branch/ref value accepted on CAP surfaces. */
export const GIT_BRANCH_NAME_MAX_LENGTH = 1_024;

/**
 * Mirrors the safety-relevant git check-ref-format --branch rules without
 * launching git: no option-like leading dash, control/space/metacharacters,
 * dot/lock components, traversal-like separators, reflog syntax, or backslash.
 */
export function isValidGitBranchName(value: string): boolean {
  if (value.length === 0 || value.length > GIT_BRANCH_NAME_MAX_LENGTH) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value === '@' || value.endsWith('.') || value.includes('..')) return false;
  if (value.includes('//') || value.includes('@{')) return false;
  // Git rejects ASCII controls, DEL, space, and these ref metacharacters. CAP
  // also rejects C1 controls so values remain safe across JSON/log/CLI seams.
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      '~^:?*[\\'.includes(character)
    ) {
      return false;
    }
  }

  const components = value.split('/');
  return components.every(
    (component) =>
      component.length > 0 &&
      !component.startsWith('.') &&
      !component.endsWith('.lock'),
  );
}

/** Shared non-transforming branch/ref schema for verified forge data. */
export const GitBranchNameSchema = z
  .string()
  .min(1)
  .max(GIT_BRANCH_NAME_MAX_LENGTH)
  .refine(
    (value) => value === value.trim() && isValidGitBranchName(value),
    'Invalid Git branch name',
  );
export type GitBranchName = z.infer<typeof GitBranchNameSchema>;
