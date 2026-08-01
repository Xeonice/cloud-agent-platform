export async function sendApiRequest(path: string) {
  const res = await fetch(`https://example.invalid${path}`, { cache: "no-store" });
  return res.json();
}
