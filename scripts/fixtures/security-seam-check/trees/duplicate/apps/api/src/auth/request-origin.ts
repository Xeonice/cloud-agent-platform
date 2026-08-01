// Fixture — the canonical origin computation, at its declared path.
export function isTrustedRequestOrigin(origin: string, allowed: string[]): boolean {
  return allowed.includes(origin);
}
