/**
 * Ground-truth exercise of the unlock-extension-axes `frontend-console` spec
 * requirement "Create-task dialog offers a runtime selector gated on
 * readiness" — specifically the "Unconfigured runtime is disabled" scenario:
 *
 *   WHEN the Claude runtime reports not ready
 *   THEN the `Claude Code` option is shown disabled with a configure hint,
 *        and `Codex` remains the default selectable runtime
 *
 * This renders the REAL `NewTaskDialog` (real hooks, real `RUNTIME_CATALOG` /
 * `isRuntimeReady` computation, real `@tanstack/react-query` cache) with the
 * `GET /runtimes` cache pre-seeded so the readiness read resolves
 * synchronously. Only the Radix `Dialog`/`Select` primitives are replaced —
 * they portal their content via a client-only `useLayoutEffect` gate
 * (`@radix-ui/react-portal`), which never fires under `renderToStaticMarkup`
 * (no DOM, no effects: confirmed empirically — the real components render
 * NOTHING under either portal in this suite's `node` test environment,
 * independent of `open`/`defaultOpen`). The replacements are structural
 * passthroughs plus a capture of each runtime `SelectItem`'s real props, so
 * the actual `disabled` / `data-runtime-ready` values the dialog computes are
 * what gets asserted — the dialog's own gating logic runs unmodified.
 */
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AGENT_RUNTIME_IDS, type Repo } from "@cap-console/contracts";
import { queryKeys } from "@/lib/api/queries";

vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({ to, children }: { to: string; children: React.ReactNode }) =>
      ReactModule.createElement("a", { href: to }, children),
    useNavigate: () => () => undefined,
  };
});

vi.mock("sonner", () => ({
  toast: { success: () => undefined, error: () => undefined },
}));

// Radix's Dialog/Select content portals to `document.body`, gated behind a
// `useLayoutEffect`-set `mounted` flag (@radix-ui/react-portal) that never
// fires under `renderToStaticMarkup`. Replace both with structural
// passthroughs so the dialog body (and the runtime selector inside it)
// actually serializes, while capturing each runtime option's real props.
vi.mock("@/components/ui/dialog", async () => {
  const ReactModule = await import("react");
  return {
    Dialog: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    DialogContent: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    DialogBody: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    DialogTitle: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("h2", null, children),
    DialogDescription: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("p", null, children),
  };
});

const { capturedRuntimeItems } = vi.hoisted(() => ({
  capturedRuntimeItems: [] as Array<{
    value: unknown;
    disabled: boolean;
    dataRuntimeReady: unknown;
    hint: string;
  }>,
}));

vi.mock("@/components/ui/select", async () => {
  const ReactModule = await import("react");
  const { renderToStaticMarkup: renderStatic } = await import(
    "react-dom/server"
  );
  return {
    Select: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    SelectTrigger: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    SelectItem: (props: Record<string, unknown>) => {
      const runtimeOption = props["data-runtime-option"];
      if (runtimeOption !== undefined) {
        capturedRuntimeItems.push({
          value: props.value,
          disabled: Boolean(props.disabled),
          dataRuntimeReady: props["data-runtime-ready"],
          hint: renderStatic(
            ReactModule.createElement(
              ReactModule.Fragment,
              null,
              props.children as React.ReactNode,
            ),
          ),
        });
      }
      return null;
    },
  };
});

import { NewTaskDialog } from "./new-task-dialog";

function repo(id: string): Repo {
  return {
    id,
    name: "demo-repo",
    gitSource: "git@github.com:owner/demo-repo.git",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
  };
}

describe("NewTaskDialog runtime selector readiness gating (unlock-extension-axes frontend-console)", () => {
  it('scenario "Unconfigured runtime is disabled": Claude un-ready renders disabled with a configure hint, Codex stays selectable', () => {
    capturedRuntimeItems.length = 0;
    const queryClient = new QueryClient();
    // Seed the readiness read the selector gates on (`GET /runtimes`) so the
    // dialog's `runtimesQuery()` resolves synchronously from cache. Built by
    // mapping the declared vocabulary (only `codex` ready) rather than a
    // hand-written two-entry list, so the assertions below hold regardless of
    // how many runtimes are currently declared in contracts.
    queryClient.setQueryData(
      queryKeys.runtimes,
      AGENT_RUNTIME_IDS.map((id) => ({ id, ready: id === "codex" })),
    );

    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <NewTaskDialog
          open
          onOpenChange={() => undefined}
          repos={[repo("00000000-0000-4000-a000-000000000001")]}
        />
      </QueryClientProvider>,
    );

    // Sanity: every declared runtime actually reached the (mocked)
    // SelectItem — i.e. the dialog body did render, not silently
    // short-circuit, and the selector is collection-driven (no dialog-local
    // runtime list capped at two).
    expect(capturedRuntimeItems).toHaveLength(AGENT_RUNTIME_IDS.length);

    const codex = capturedRuntimeItems.find((item) => item.value === "codex");
    const claude = capturedRuntimeItems.find(
      (item) => item.value === "claude-code",
    );

    // Codex reports ready and remains the selectable default.
    expect(codex?.disabled).toBe(false);
    expect(codex?.dataRuntimeReady).toBe("true");

    // Claude Code reports NOT ready: shown disabled with a configure hint,
    // never presented as selectable-and-failing-at-launch.
    expect(claude?.disabled).toBe(true);
    expect(claude?.dataRuntimeReady).toBe("false");
    expect(claude?.hint).toContain("未配置凭据，去设置中连接后可用");

    // Every OTHER un-ready runtime (if any are currently declared beyond the
    // two named in the scenario) is disabled too — the gate is generic over
    // the collection, not a codex/claude-code special case.
    for (const item of capturedRuntimeItems) {
      if (item.value === "codex") continue;
      expect(item.disabled).toBe(true);
      expect(item.dataRuntimeReady).toBe("false");
    }
  });

  it("both ready: neither option is disabled (control case)", () => {
    capturedRuntimeItems.length = 0;
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      queryKeys.runtimes,
      AGENT_RUNTIME_IDS.map((id) => ({ id, ready: true })),
    );

    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <NewTaskDialog
          open
          onOpenChange={() => undefined}
          repos={[repo("00000000-0000-4000-a000-000000000001")]}
        />
      </QueryClientProvider>,
    );

    expect(capturedRuntimeItems).toHaveLength(AGENT_RUNTIME_IDS.length);
    for (const item of capturedRuntimeItems) {
      expect(item.disabled).toBe(false);
      expect(item.dataRuntimeReady).toBe("true");
    }
  });
});
