import * as React from "react";

import { CodexDirectDialog } from "@/components/settings/codex-direct-dialog";

export function CodexDeviceLoginStoryApp() {
  const [open, setOpen] = React.useState(true);
  const [connectedCount, setConnectedCount] = React.useState(0);

  return (
    <main className="device-login-story">
      <section aria-label="Codex 设备登录浏览器验收">
        <p className="device-login-story__eyebrow">浏览器验收夹具</p>
        <h1>Codex 官方账号连接</h1>
        <p>
          此页面挂载生产对话框；登录 API 由 Playwright 在浏览器网络边界拦截。
        </p>
        <button type="button" onClick={() => setOpen(true)}>
          打开官方账号对话框
        </button>
        <output data-connected-count>{connectedCount}</output>
      </section>

      <CodexDirectDialog
        open={open}
        onOpenChange={setOpen}
        connected={false}
        login="playwright@local"
        capable
        onConnected={() => setConnectedCount((count) => count + 1)}
      />
    </main>
  );
}
