// Fixture — a consumer. Importing and calling the seam is not a second
// implementation, and the gate must not count it as one.
import { isTrustedRequestOrigin } from './request-origin';

export function canActivate(origin: string): boolean {
  return isTrustedRequestOrigin(origin, ['https://console.example']);
}
