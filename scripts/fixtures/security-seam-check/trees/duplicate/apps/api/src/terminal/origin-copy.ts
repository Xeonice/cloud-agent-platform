// Fixture — the defect the D-table register exists to prevent: a second
// implementation of a registered seam, here in the WS path, deciding the same
// security question with its own rules.
export function isTrustedRequestOrigin(origin: string): boolean {
  return origin.endsWith('.example');
}
