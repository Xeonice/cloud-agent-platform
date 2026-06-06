/**
 * Pure derivations for the Codex credential UI (Track 14, tasks 14.4/14.5).
 *
 * The credential `state` (`not_connected` / `not_saved` / `connected`) is the
 * SINGLE source the status card pill, the activation tab subtitles, and the
 * provider-foot pills all key off — so all three render the same condition. The
 * mappings below are PURE (no React, no `window`), keeping the state→label
 * contract unit-testable and impossible to drift between the three surfaces.
 *
 * SECURITY: nothing here touches the plaintext key. The "connected/saved" label
 * is derived from the non-secret `state` flag the read contract exposes
 * (`hasApiKey` + masked suffix), never from a key value.
 */
import type {
  CodexCredential,
  CodexCredentialMode,
  CodexCredentialState,
} from "@cap/contracts";
import type { StatusPillVariant } from "@/components/status-pill";

/** The status-card mode pill text per state (verbatim prototype copy). */
export function modePillLabel(state: CodexCredentialState): string {
  switch (state) {
    case "connected":
      return "已连接";
    case "not_saved":
      return "未保存";
    default:
      return "未连接";
  }
}

/** The pill tone per state: green when connected, warn otherwise. */
export function statePillVariant(
  state: CodexCredentialState,
): StatusPillVariant {
  return state === "connected" ? "green" : "warn";
}

/** Whether the access-summary / login-state dot is the "ready" (success) dot. */
export function isReady(state: CodexCredentialState): boolean {
  return state === "connected";
}

/** The access-summary title + copy, reflecting the live credential. */
export function accessSummary(cred: CodexCredential): {
  title: string;
  copy: string;
} {
  if (cred.state === "connected") {
    if (cred.mode === "official") {
      return {
        title: "官方账号已连接",
        copy: "创建任务时默认使用官方短期认证会话；可随时切换到兼容提供方。",
      };
    }
    return {
      title: "兼容提供方已连接",
      copy: "远端 Agent 在任务运行时使用已保存的模型调用凭据；密钥不再明文展示。",
    };
  }
  if (cred.state === "not_saved") {
    return {
      title: "凭据尚未保存",
      copy: "已填写连接信息但还未保存；保存后才会作为任务运行时的模型凭据。",
    };
  }
  return {
    title: "未配置运行凭据",
    copy: "选择官方账号或兼容提供方；创建任务时只选择仓库和执行策略。",
  };
}

/**
 * Per-tab subtitle. The ACTIVE mode reflects the live `state`; the inactive mode
 * always shows its baseline ("未连接" for official, "未保存" for compatible) so a
 * connected compatible provider does not mislabel the official tab as connected.
 */
export function tabSubtitle(
  mode: CodexCredentialMode,
  cred: CodexCredential,
): string {
  const isActive = cred.mode === mode;
  if (mode === "official") {
    return isActive ? modePillLabel(cred.state) : "未连接";
  }
  return isActive ? modePillLabel(cred.state) : "未保存";
}

/** The provider-foot pill text for a given mode (mirrors `tabSubtitle`). */
export function providerFootLabel(
  mode: CodexCredentialMode,
  cred: CodexCredential,
): string {
  return tabSubtitle(mode, cred);
}

/** The provider-foot pill tone for a given mode. */
export function providerFootVariant(
  mode: CodexCredentialMode,
  cred: CodexCredential,
): StatusPillVariant {
  const connected = cred.mode === mode && cred.state === "connected";
  return connected ? "green" : "warn";
}

/** The provider-meta value line (运行身份 / 默认模型) per mode. */
export function providerMetaValue(
  mode: CodexCredentialMode,
  cred: CodexCredential,
): string {
  if (mode === "official") {
    return cred.mode === "official" && cred.state === "connected"
      ? "官方短期会话"
      : "未连接";
  }
  // compatible: show the selected default model when connected, else status.
  if (cred.mode === "compatible" && cred.state === "connected") {
    return cred.defaultModel ?? "已连接";
  }
  return "未配置";
}
