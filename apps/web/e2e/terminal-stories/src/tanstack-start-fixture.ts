type AsyncBranch = (...args: readonly unknown[]) => unknown;

/** Browser story seam for TanStack Start's compile-time isomorphic helper. */
export function createIsomorphicFn(): {
  client(branch: AsyncBranch): {
    server(serverBranch: AsyncBranch): AsyncBranch;
  };
} {
  return {
    client(branch) {
      return {
        server() {
          return branch;
        },
      };
    },
  };
}
