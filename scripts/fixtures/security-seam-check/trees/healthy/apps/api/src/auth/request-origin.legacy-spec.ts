// Fixture — a test double that redefines the seam. The manifest entry excludes
// this shape (`**/*.legacy-spec.ts`), so it must not count toward uniqueness;
// the healthy tree stays green only if the exclude is honoured.
export function isTrustedRequestOrigin(): boolean {
  return true;
}
