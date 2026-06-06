/**
 * Router factory (rebuild-console-tanstack-start D3.2).
 *
 * `getRouter()` constructs a NEW `QueryClient` PER REQUEST and wires
 * `setupRouterSsrQueryIntegration`. This is load-bearing: a module-singleton
 * QueryClient would LEAK cache across users during SSR — unacceptable once the
 * console is multi-user (D1). The QueryClient is therefore created inside the
 * factory, passed into the router context so loaders/components share it, and
 * handed to the SSR-query integration for dehydrate/hydrate.
 */
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // Per-request QueryClient — never a module singleton (SSR cache-leak guard).
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Avoid immediate client refetch of values already dehydrated by SSR.
        staleTime: 60 * 1000,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // The SSR-query integration owns dehydration; do not also reload on the client.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
