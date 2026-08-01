// Fixture — the canonical origin computation. Never compiled; read as text.
export function isTrustedRequestOrigin(origin: string, allowed: string[]): boolean {
  return allowed.includes(origin);
}
