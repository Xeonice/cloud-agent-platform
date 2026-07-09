/**
 * `/images` — 镜像库管理.
 *
 * This is the product-nav entry for the sandbox base image/environment registry.
 * The underlying API still calls the domain `sandbox-environments` because it
 * can point to AIO images or BoxLite images; the operator
 * surface names the workflow "镜像管理" so admins can maintain the selectable
 * task base-image library from the left navigation. User-scoped default image
 * selection lives in `/settings`.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Plus } from "lucide-react";

import {
  authSessionQuery,
  sandboxEnvironmentsQuery,
} from "@/lib/api/queries";
import { isAdminSession } from "@/components/shell/update-banner";
import { SandboxEnvironmentsCard } from "@/components/settings/sandbox-environments-card";
import { Panel, PanelHead } from "@/components/settings/panel";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_app/images")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(authSessionQuery()),
      context.queryClient.ensureQueryData(sandboxEnvironmentsQuery()),
    ]);
  },
  component: ImagesPage,
});

function ImagesPage() {
  const { data: session } = useQuery(authSessionQuery());
  const isAdmin = isAdminSession(session ?? undefined);

  return (
    <>
      <section className="mb-[18px] grid items-end gap-4 min-[821px]:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            镜像
          </div>
          <h1 className="max-w-[880px] text-[clamp(24px,3vw,32px)] leading-[1.18] font-semibold tracking-[-0.8px] text-foreground">
            镜像管理
          </h1>
          <p className="mt-[7px] max-w-[820px] text-sm leading-[1.58] text-muted-foreground">
            注册和验证已发布的 AIO / BoxLite 任务基础镜像引用；用户默认镜像在设置页选择。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 justify-self-start min-[821px]:justify-self-end">
          <Button asChild variant="outline" className="gap-2">
            <Link to="/help/sandbox-images">
              <BookOpen className="size-4" />
              查看文档
            </Link>
          </Button>
          <Button asChild variant="outline" className="gap-2">
            <Link to="/tasks/new" search={{ scheduleId: undefined }}>
              <Plus className="size-4" />
              新建任务
            </Link>
          </Button>
        </div>
      </section>

      <div className="grid max-w-[760px] gap-6">
        {isAdmin ? <SandboxEnvironmentsCard /> : <ImagesAdminRequired />}
      </div>
    </>
  );
}

function ImagesAdminRequired() {
  return (
    <Panel>
      <PanelHead>
        <div className="font-mono text-[11px] uppercase text-muted-foreground">
          Admin
        </div>
        <h2 className="text-sm font-semibold text-foreground">需要管理员权限</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          注册、验证和维护镜像库需要管理员账号；当前账号的默认镜像请在设置页选择。
        </p>
      </PanelHead>
    </Panel>
  );
}
