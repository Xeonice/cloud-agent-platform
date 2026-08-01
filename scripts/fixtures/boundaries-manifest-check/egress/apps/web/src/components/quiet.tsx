import { useQuery } from "./query";

// A comment may say fetch(url) all it likes; a comment is not egress.
export function Quiet() {
  const query = useQuery();
  const docs = "https://example.invalid/docs/fetch";
  const label = `see ${docs} for how the seam does its fetch`;
  const refresh = () => void query.refetch();
  const prefetch = () => query.client.fetchQuery();

  return { label, refresh, prefetch };
}
