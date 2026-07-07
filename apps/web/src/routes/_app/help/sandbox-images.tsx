/**
 * `/help/sandbox-images` — in-console custom sandbox image guide.
 *
 * Renders trusted, app-authored markdown through the shared `Markdown`
 * component, matching the forge-token and Resend help pages. The page lives
 * inside `_app`, so it inherits the existing auth gate and shell.
 */
import { createFileRoute } from "@tanstack/react-router";

import sandboxImagesMd from "@/content/sandbox-images.md?raw";
import { Markdown } from "@/components/markdown/markdown";

export const Route = createFileRoute("/_app/help/sandbox-images")({
  component: SandboxImagesHelpPage,
});

function SandboxImagesHelpPage() {
  return (
    <>
      <section className="mb-[18px] grid items-end gap-4">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            帮助
          </div>
          <h1 className="max-w-[880px] text-3xl leading-tight font-semibold text-foreground">
            创建和维护自定义镜像
          </h1>
          <p className="mt-[7px] max-w-[820px] text-sm leading-[1.58] text-muted-foreground">
            基于官方 AIO / BoxLite 基镜像扩展、发布到 registry，并在镜像管理中验证后供任务选择。
          </p>
        </div>
      </section>

      <section className="rounded-xl bg-card p-6 shadow-ring">
        <Markdown source={sandboxImagesMd} />
      </section>
    </>
  );
}
