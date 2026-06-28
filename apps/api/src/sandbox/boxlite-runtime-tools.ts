export const DEFAULT_BOXLITE_RUNTIME_REQUIRED_TOOLS = [
  'bash',
  'claude',
  'codex',
  'git',
  'gzip',
  'node',
  'openspec',
  'sh',
  'tar',
  'tmux',
] as const;

export function readBoxLiteRuntimeRequiredTools(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return normalizeBoxLiteRuntimeRequiredTools(
    env['BOXLITE_RUNTIME_REQUIRED_TOOLS'] ??
      env['CAP_BOXLITE_RUNTIME_REQUIRED_TOOLS'],
  );
}

export function normalizeBoxLiteRuntimeRequiredTools(
  raw: string | undefined,
): readonly string[] {
  const value = raw?.trim();
  if (!value) return [...DEFAULT_BOXLITE_RUNTIME_REQUIRED_TOOLS];

  const tools = value
    .split(/[,\s]+/)
    .map((tool) => tool.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const tool of tools) {
    if (!/^[A-Za-z0-9._+-]+$/.test(tool)) {
      throw new Error(
        `BOXLITE_RUNTIME_REQUIRED_TOOLS contains invalid tool name: ${tool}`,
      );
    }
    if (!out.includes(tool)) out.push(tool);
  }
  return out;
}
