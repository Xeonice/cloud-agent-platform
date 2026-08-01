export async function viaWindow(url: string) {
  return window.fetch(url, { cache: "no-store" });
}

export async function viaGlobalThis(url: string) {
  return globalThis.fetch(url);
}

export async function viaAlias(url: string) {
  const send = fetch;
  return send(url);
}

export async function viaDestructuredAlias(url: string) {
  const { fetch: call } = window;
  return call(url);
}

export function viaSocket(url: string) {
  return new WebSocket(url);
}
