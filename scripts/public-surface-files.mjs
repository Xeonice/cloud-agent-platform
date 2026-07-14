import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_SURFACE_RULES = Object.freeze([
  ['contracts', /^packages\/contracts\/(?:src\/|package\.json$)/],
  ['publicV1', /^apps\/api\/src\/v1\//],
  ['mcp', /^apps\/api\/src\/mcp\//],
  ['openapi', /^apps\/api\/src\/openapi\//],
  ['publicErrors', /^apps\/api\/src\/public-surface\//],
  ['playground', /^apps\/web\/src\/components\/api\//],
  [
    'developerWorkflow',
    /^(?:package\.json|apps\/(?:api|web)\/package\.json|turbo\.json|lint-staged\.config\.mjs|\.husky\/pre-(?:commit|push)|\.claude\/hooks\/typecheck-lint-edited\.sh|\.github\/workflows\/ci\.yml|scripts\/public-surface-(?:adversarial|files|tests|hook|pre-push)(?:\.test)?\.mjs)$/,
  ],
]);

const OPENSPEC_CHANGE_ARTIFACT =
  /^openspec\/changes\/[^/]+\/(?:proposal\.md|design\.md|tasks\.md|surface-impact\.json|specs\/.*\/spec\.md)$/;

const OPENSPEC_WORKFLOW_RULES = Object.freeze([
  /^\.codex\/skills\/openspec-(?:propose|apply-change)\//,
  /^\.claude\/skills\/openspec-(?:propose|apply-change)\//,
  /^\.claude\/workflows\/opsx-(?:propose-deep|apply-tracks|verify)\.js$/,
  /^scripts\/(?:openspec-metadata|task-verifiers|verify-task)(?:\.|-)/,
]);

function slash(value) {
  return value.split(path.sep).join('/');
}

export function toRepoRelativePath(file, root = process.cwd()) {
  if (typeof file !== 'string' || file.trim().length === 0) return null;
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.isAbsolute(file)
    ? path.resolve(file)
    : path.resolve(absoluteRoot, file);
  const relative = path.relative(absoluteRoot, absoluteFile);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return null;
  }
  return slash(relative);
}

export function classifyPublicSurfaceFiles(files, root = process.cwd()) {
  const normalized = [];
  const categories = new Set();
  let hasTypeScript = false;
  let openspecMetadata = false;

  for (const file of files) {
    const relative = toRepoRelativePath(file, root);
    if (!relative) continue;
    normalized.push(relative);

    if (/\.(?:ts|tsx)$/.test(relative)) hasTypeScript = true;
    for (const [category, pattern] of PUBLIC_SURFACE_RULES) {
      if (pattern.test(relative)) categories.add(category);
    }
    if (
      OPENSPEC_CHANGE_ARTIFACT.test(relative) ||
      OPENSPEC_WORKFLOW_RULES.some((pattern) => pattern.test(relative))
    ) {
      openspecMetadata = true;
    }
  }

  return Object.freeze({
    files: Object.freeze([...new Set(normalized)].sort()),
    categories: Object.freeze([...categories].sort()),
    hasTypeScript,
    publicSurface: categories.size > 0,
    openspecMetadata,
  });
}

function isMainModule() {
  const argvEntry = process.argv[1];
  return argvEntry && path.resolve(argvEntry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const result = classifyPublicSurfaceFiles(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
