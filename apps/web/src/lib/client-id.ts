/**
 * A stable per-tab client identity used by the write-lock protocol (D7) so the
 * orchestrator can attribute the lease, heartbeats, and takeover requests to a
 * single browser tab. Persisted in `sessionStorage` so it survives a soft
 * reconnect within the same tab but is distinct across tabs/windows.
 */
const STORAGE_KEY = "cap.clientId";

export function getClientId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const generated =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `c-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    window.sessionStorage.setItem(STORAGE_KEY, generated);
    return generated;
  } catch {
    return `c-${Math.random().toString(36).slice(2)}`;
  }
}
