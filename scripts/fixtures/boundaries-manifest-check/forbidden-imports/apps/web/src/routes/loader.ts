export async function loadSandbox() {
  const runtime = await import("@cap-console/sandbox-core");
  return runtime;
}

export async function loadService() {
  const service = await import("../../../api/src/tasks/tasks.service");
  return service;
}
