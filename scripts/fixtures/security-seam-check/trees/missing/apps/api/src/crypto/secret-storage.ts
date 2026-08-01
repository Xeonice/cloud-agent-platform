// Fixture — this tree has the decryption seam but no request-origin.ts: the
// origin seam was moved (or deleted) without the manifest following it.
export function decryptStored(value: string): string {
  return value;
}
