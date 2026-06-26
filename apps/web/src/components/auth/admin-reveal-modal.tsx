/**
 * `AdminRevealModal` — the one-time default-admin credential reveal
 * (add-private-account-identity, track frontend, task 9.5; spec
 * `default-admin-bootstrap`).
 *
 * When `ADMIN_PASSWORD` is not provided, the boot seed generates a strong random
 * admin password, stores only its argon2 hash, and holds the plaintext in
 * process memory. A one-time reveal endpoint returns `{ email, password }`
 * exactly once; after it is consumed a persisted flag
 * (`SystemSettings.adminRevealConsumedAt`) prevents any further reveal and the
 * in-memory plaintext is cleared. This modal is the console face of that reveal:
 * on first console visit it attempts the reveal, and shows the credentials
 * EXACTLY ONCE so the operator can capture them before the forced first-login
 * password change.
 *
 * SHIPS INERT (the dangerous-surface posture): the reveal is a SERVER one-time
 * response, NEVER client-fabricated. The component renders nothing unless the
 * real auth backend is wired (`isAuthCapable()`); under the mock gate / visual
 * harness it is silent, so deploying it never fabricates a credential prompt.
 * The single-use guarantee is the BACKEND's consumed-flag — the client only ever
 * displays what the one reveal call returns (a subsequent call returns nothing,
 * so the modal stays closed on later visits).
 *
 * SSR-safe: the reveal fetch runs in a post-mount effect (no window/fetch during
 * render); the modal renders nothing until a payload resolves.
 */
import * as React from "react";

import { isAuthCapable } from "@/lib/mock-session";
import { apiBaseUrl } from "@/lib/config";
import { StatusPill } from "@/components/status-pill";

/** The one-time reveal payload: the seeded admin email + generated password. */
export interface AdminRevealCredentials {
  email: string;
  password: string;
}

/** The reveal endpoint path (exact-match `PUBLIC_AUTH_PATHS`, D10). */
const REVEAL_PATH = "/auth/admin-reveal";

/**
 * Fetch the one-time admin reveal. Returns the credentials on the single
 * successful reveal, or `null` when there is nothing to reveal (already
 * consumed, admin set via `ADMIN_PASSWORD`, or the endpoint is unavailable).
 * Never throws to the caller — a failed/empty reveal simply keeps the modal
 * closed.
 */
async function fetchAdminReveal(): Promise<AdminRevealCredentials | null> {
  try {
    const res = await fetch(`${apiBaseUrl()}${REVEAL_PATH}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (
      body &&
      typeof body === "object" &&
      typeof (body as { email?: unknown }).email === "string" &&
      typeof (body as { password?: unknown }).password === "string"
    ) {
      return body as AdminRevealCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

export interface AdminRevealModalProps {
  /**
   * Test/preview seam: when provided, the modal shows these credentials instead
   * of calling the reveal endpoint. Production mounts pass nothing so the modal
   * only ever shows the SERVER's one-time reveal.
   */
  credentials?: AdminRevealCredentials | null;
}

export function AdminRevealModal({ credentials }: AdminRevealModalProps) {
  const [creds, setCreds] = React.useState<AdminRevealCredentials | null>(
    credentials ?? null,
  );
  const [dismissed, setDismissed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    // Explicit credentials (test/preview) take precedence over the fetch.
    if (credentials !== undefined) {
      setCreds(credentials);
      return;
    }
    // Ships inert: only attempt the SERVER reveal when the real auth backend is
    // wired; under the mock gate / visual harness this never fabricates a prompt.
    if (!isAuthCapable()) return;
    let active = true;
    void fetchAdminReveal().then((result) => {
      if (active) setCreds(result);
    });
    return () => {
      active = false;
    };
  }, [credentials]);

  if (!creds || dismissed) return null;

  async function handleCopy() {
    if (!creds) return;
    try {
      await navigator.clipboard.writeText(
        `${creds.email}\n${creds.password}`,
      );
      setCopied(true);
    } catch {
      // Clipboard unavailable — the operator can still read the values.
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-reveal-title"
        className="grid w-[min(460px,100%)] gap-4 rounded-2xl bg-background p-[clamp(22px,4vw,30px)] shadow-card"
      >
        <header className="grid gap-1.5">
          <StatusPill variant="warn" className="w-fit">
            仅显示一次
          </StatusPill>
          <h2
            id="admin-reveal-title"
            className="m-0 mt-1 text-xl font-semibold tracking-[-0.4px] text-ink"
          >
            默认管理员凭据
          </h2>
          <p className="m-0 text-[13px] leading-[1.6] text-muted-foreground">
            部署随机生成了默认管理员密码。这串凭据只会显示这一次——请立即妥善保存，关闭后无法再次查看。首次登录会强制改密。
          </p>
        </header>

        <div className="grid overflow-hidden rounded-md shadow-ring">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-card px-3 py-2.5 text-[13px]">
            <span className="text-muted-foreground">邮箱</span>
            <strong className="font-mono font-semibold text-foreground">
              {creds.email}
            </strong>
          </div>
          <div className="flex items-center justify-between gap-3 bg-card px-3 py-2.5 text-[13px]">
            <span className="text-muted-foreground">密码</span>
            <strong className="font-mono font-semibold break-all text-foreground">
              {creds.password}
            </strong>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
          >
            {copied ? "已复制" : "复制凭据"}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            我已保存，关闭
          </button>
        </div>
      </section>
    </div>
  );
}
