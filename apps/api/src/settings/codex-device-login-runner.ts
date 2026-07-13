/**
 * Process boundary for the short-lived Codex App Server authentication worker.
 *
 * The settings service owns account/session policy. Implementations of this port
 * own only the disposable worker and must never surface protocol payloads,
 * device codes, or credential contents through errors.
 */

export const CODEX_DEVICE_LOGIN_RUNNER = Symbol('CodexDeviceLoginRunner');

export type CodexDeviceLoginRunnerErrorCategory =
  | 'device_login_worker_not_configured'
  | 'device_login_worker_image_unavailable'
  | 'device_login_worker_start_failed'
  | 'device_login_worker_preflight_failed'
  | 'device_login_protocol_invalid'
  | 'device_login_protocol_timeout'
  | 'device_login_worker_exited'
  | 'device_login_authorization_failed'
  | 'device_login_credential_read_failed'
  | 'device_login_credential_too_large'
  | 'device_login_worker_cleanup_failed'
  | 'device_login_cancelled';

const SAFE_ERROR_MESSAGES: Record<CodexDeviceLoginRunnerErrorCategory, string> = {
  device_login_worker_not_configured: 'Codex 登录工作器未配置，请设置 AIO_SANDBOX_IMAGE。',
  device_login_worker_image_unavailable:
    'Codex 登录工作器镜像不可用，请确认固定版本的 AIO 镜像已在本机准备完成。',
  device_login_worker_start_failed: 'Codex 登录工作器启动失败。',
  device_login_worker_preflight_failed: 'Codex 登录工作器预检失败。',
  device_login_protocol_invalid: 'Codex 登录协议响应无效。',
  device_login_protocol_timeout: 'Codex 登录工作器响应超时。',
  device_login_worker_exited: 'Codex 登录工作器意外退出。',
  device_login_authorization_failed: 'Codex 授权未完成。',
  device_login_credential_read_failed: 'Codex 登录凭据读取失败。',
  device_login_credential_too_large: 'Codex 登录凭据超过允许大小。',
  device_login_worker_cleanup_failed: 'Codex 登录工作器清理失败。',
  device_login_cancelled: 'Codex 登录已取消。',
};

/** Error whose category and message are both safe to expose to operators. */
export class CodexDeviceLoginRunnerError extends Error {
  readonly name = 'CodexDeviceLoginRunnerError';

  constructor(readonly category: CodexDeviceLoginRunnerErrorCategory) {
    super(SAFE_ERROR_MESSAGES[category]);
  }
}

export function isCodexDeviceLoginRunnerError(
  value: unknown,
): value is CodexDeviceLoginRunnerError {
  return value instanceof CodexDeviceLoginRunnerError;
}

export interface CodexDeviceLoginOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CodexDeviceLoginAuthorization {
  readonly loginId: string;
  readonly verificationUrl: string;
  readonly userCode: string;
}

export type CodexDeviceLoginCompletion =
  | { readonly loginId: string; readonly success: true }
  | {
      readonly loginId: string;
      readonly success: false;
      readonly category: 'device_login_authorization_failed';
    };

/** A single live worker returned after structured device-code preparation. */
export interface CodexDeviceLoginRunnerHandle {
  readonly sessionId: string;
  readonly authorization: CodexDeviceLoginAuthorization;

  waitForCompletion(
    options?: CodexDeviceLoginOperationOptions,
  ): Promise<CodexDeviceLoginCompletion>;

  /** Requests App Server cancellation when a login id exists, then reclaims the worker. */
  cancel(options?: CodexDeviceLoginOperationOptions): Promise<void>;

  /** Reads the file-backed auth document without parsing or logging it. */
  readCredential(options?: CodexDeviceLoginOperationOptions): Promise<string>;

  /** Idempotently stops streams, exec work, and the temporary container. */
  dispose(): Promise<void>;
}

export interface CodexDeviceLoginStartOptions extends CodexDeviceLoginOperationOptions {
  readonly sessionId: string;
}

export interface CodexDeviceLoginRunner {
  start(options: CodexDeviceLoginStartOptions): Promise<CodexDeviceLoginRunnerHandle>;

  /** Removes labelled workers left by an earlier ungraceful API shutdown. */
  disposeOrphans(options?: CodexDeviceLoginOperationOptions): Promise<void>;
}
