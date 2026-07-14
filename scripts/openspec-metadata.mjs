#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ts from 'typescript';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIRECTORY, '..');

export const SURFACE_STATUSES = Object.freeze([
  'changed',
  'unchanged',
  'derived',
  'excluded',
  'not-applicable',
]);

export const SURFACE_KEYS = Object.freeze([
  'publicV1',
  'mcp',
  'openapi',
  'apiPlayground',
  'internalOnly',
]);

export const TASK_SURFACES = Object.freeze([
  'contracts',
  'public-v1',
  'mcp',
  'openapi',
  'playground',
  'openspec',
  'developer-workflow',
  'ci',
  'docs',
]);

const SEMANTIC_TASK_SURFACES = Object.freeze([
  'contracts',
  'public-v1',
  'mcp',
]);

const PUBLIC_SURFACE_KEYS = Object.freeze([
  'publicV1',
  'mcp',
  'openapi',
  'apiPlayground',
]);

function freezeVerifier(argv, description) {
  return Object.freeze({
    description,
    argv: Object.freeze(
      argv.map((step) => Object.freeze([...step])),
    ),
  });
}

/**
 * The only commands that task metadata may invoke.
 *
 * Each verifier is one or more fixed argv vectors. The runner never evaluates a
 * Markdown string as a command and always invokes these vectors with
 * `shell: false`.
 */
export const VERIFIER_ALLOWLIST = Object.freeze({
  'openspec-metadata': freezeVerifier(
    [[process.execPath, '--test', 'scripts/openspec-metadata.test.mjs']],
    'Validate the OpenSpec sidecar, task metadata, mirrored skills, and backbone.',
  ),
  'contracts-registry': freezeVerifier(
    [['pnpm', '--filter', '@cap/contracts', 'test']],
    'Build and test the transport-neutral public contract registry.',
  ),
  'api-public-errors': freezeVerifier(
    [['pnpm', '--filter', '@cap/api', 'test']],
    'Build and test the API public error boundary.',
  ),
  'api-mcp': freezeVerifier(
    [['pnpm', '--filter', '@cap/api', 'test']],
    'Build and test MCP registration and adapter behavior.',
  ),
  'api-v1': freezeVerifier(
    [['pnpm', '--filter', '@cap/api', 'test']],
    'Build and test Public V1 bindings and behavior.',
  ),
  'openapi-playground': freezeVerifier(
    [
      ['pnpm', '--filter', '@cap/api', 'test'],
      ['pnpm', '--filter', '@cap/web', 'test'],
    ],
    'Test OpenAPI and API Playground projections.',
  ),
  'public-surface-fast': freezeVerifier(
    [['pnpm', 'test:public-surface']],
    'Run the focused infrastructure-free public-surface parity suite.',
  ),
  'public-surface-full': freezeVerifier(
    [['pnpm', 'verify:public-surface']],
    'Run the fresh full public-surface verification gate.',
  ),
  'task-model-evidence': freezeVerifier(
    [
      ['pnpm', '-w', 'exec', 'turbo', 'run', 'build', '--filter=@cap/api'],
      [process.execPath, 'apps/api/test/task-model-evidence-offline.mjs'],
    ],
    'Validate retained task-model Phase1/Phase2 evidence and checked manifest parity without credentials or network access.',
  ),
  'workflow-gates': freezeVerifier(
    [['pnpm', 'verify:public-surface']],
    'Exercise the shared hook and CI public-surface gate.',
  ),
  docs: freezeVerifier(
    [['git', 'diff', '--check']],
    'Reject malformed documentation patches and whitespace errors.',
  ),
});

export class MetadataValidationError extends Error {
  constructor(subject, issues) {
    super(
      `${subject} validation failed:\n${issues
        .map((issue) => `- ${issue}`)
        .join('\n')}`,
    );
    this.name = 'MetadataValidationError';
    this.subject = subject;
    this.issues = [...issues];
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function addUnknownKeyIssues(value, allowedKeys, path, issues) {
  if (!isPlainObject(value)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is not supported`);
  }
}

function requirePlainObject(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  return true;
}

function requireNonEmptyString(value, path, issues) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string`);
    return false;
  }
  return true;
}

function readStringArray(value, path, issues, { required = false } = {}) {
  if (value === undefined) {
    if (required) issues.push(`${path} is required`);
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  if (required && value.length === 0) {
    issues.push(`${path} must not be empty`);
  }
  const result = [];
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      issues.push(`${path}[${index}] must be a non-empty string`);
      continue;
    }
    const normalized = item.trim();
    if (seen.has(normalized)) {
      issues.push(`${path} contains duplicate value ${JSON.stringify(normalized)}`);
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseJsonMetadata(raw, path, issues) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    issues.push(`${path} must be valid JSON: ${error.message}`);
    return undefined;
  }
}

function validateTrackGraph(tracks, issues) {
  const byName = new Map(tracks.map((track) => [track.name, track]));
  for (const track of tracks) {
    for (const dependency of track.depends) {
      if (dependency === track.name) {
        issues.push(`track ${track.name} cannot depend on itself`);
      } else if (!byName.has(dependency)) {
        issues.push(`track ${track.name} depends on unknown track ${dependency}`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(name, stack) {
    if (visited.has(name) || !byName.has(name)) return;
    if (visiting.has(name)) {
      issues.push(`track dependency cycle detected: ${[...stack, name].join(' -> ')}`);
      return;
    }
    visiting.add(name);
    const track = byName.get(name);
    for (const dependency of track.depends) visit(dependency, [...stack, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of byName.keys()) visit(name, []);
}

function validateRequirementTrackCoupling(tracks, tasks, issues) {
  const tracksByName = new Map(tracks.map((track) => [track.name, track]));
  const reachability = new Map();

  function reachableDependencies(trackName) {
    if (reachability.has(trackName)) return reachability.get(trackName);
    const reachable = new Set();
    const pending = [...(tracksByName.get(trackName)?.depends ?? [])];
    while (pending.length > 0) {
      const dependency = pending.pop();
      if (reachable.has(dependency)) continue;
      reachable.add(dependency);
      const dependencyTrack = tracksByName.get(dependency);
      if (dependencyTrack) pending.push(...dependencyTrack.depends);
    }
    reachability.set(trackName, reachable);
    return reachable;
  }

  function tracksAreExplicitlyCoupled(left, right) {
    return (
      left === right ||
      reachableDependencies(left).has(right) ||
      reachableDependencies(right).has(left)
    );
  }

  const requirementSurfaces = new Map();
  for (const task of tasks) {
    if (
      !task.track ||
      !Array.isArray(task.requirements) ||
      !Array.isArray(task.surfaces)
    ) {
      continue;
    }
    for (const requirement of task.requirements) {
      let surfaces = requirementSurfaces.get(requirement);
      if (!surfaces) {
        surfaces = new Map();
        requirementSurfaces.set(requirement, surfaces);
      }
      for (const surface of task.surfaces) {
        if (!SEMANTIC_TASK_SURFACES.includes(surface)) continue;
        let surfaceTracks = surfaces.get(surface);
        if (!surfaceTracks) {
          surfaceTracks = new Set();
          surfaces.set(surface, surfaceTracks);
        }
        surfaceTracks.add(task.track);
      }
    }
  }

  for (const [requirement, surfaces] of requirementSurfaces) {
    for (let leftIndex = 0; leftIndex < SEMANTIC_TASK_SURFACES.length; leftIndex += 1) {
      const leftSurface = SEMANTIC_TASK_SURFACES[leftIndex];
      const leftTracks = surfaces.get(leftSurface);
      if (!leftTracks) continue;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < SEMANTIC_TASK_SURFACES.length;
        rightIndex += 1
      ) {
        const rightSurface = SEMANTIC_TASK_SURFACES[rightIndex];
        const rightTracks = surfaces.get(rightSurface);
        if (!rightTracks) continue;
        const coupled = [...leftTracks].some((leftTrack) =>
          [...rightTracks].some((rightTrack) =>
            tracksAreExplicitlyCoupled(leftTrack, rightTrack),
          ),
        );
        if (coupled) continue;
        issues.push(
          `requirement ${requirement} has uncoupled semantic surfaces ` +
            `${leftSurface} (${[...leftTracks].sort().join(', ')}) and ` +
            `${rightSurface} (${[...rightTracks].sort().join(', ')}); ` +
            'place them in one track or add an explicit track dependency',
        );
      }
    }
  }
}

/** Parse and validate the machine-readable child metadata in tasks.md. */
export function parseTaskMetadata(
  markdown,
  {
    allowedRequirementIds,
    verifierAllowlist = VERIFIER_ALLOWLIST,
    allowedSurfaces = TASK_SURFACES,
  } = {},
) {
  if (typeof markdown !== 'string') {
    throw new TypeError('tasks markdown must be a string');
  }

  const issues = [];
  const tracks = [];
  const tasks = [];
  const taskIds = new Set();
  const trackNames = new Set();
  const trackNumbers = new Set();
  const requirementSet =
    allowedRequirementIds === undefined
      ? undefined
      : new Set(allowedRequirementIds);
  const surfaceSet = new Set(allowedSurfaces);
  let currentTrack;
  let currentTask;
  let metadataWindowOpen = false;

  function finalizeTask() {
    if (!currentTask) return;
    const path = `task ${currentTask.id}`;
    for (const field of ['requirements', 'surfaces', 'verify']) {
      if (currentTask[field] === undefined) {
        issues.push(`${path} is missing adjacent ${field} metadata`);
      }
    }
    if (Array.isArray(currentTask.requirements)) {
      if (currentTask.requirements.length === 0) {
        issues.push(`${path}.requirements must not be empty`);
      }
      for (const requirement of currentTask.requirements) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requirement)) {
          issues.push(
            `${path}.requirements contains invalid reference ${JSON.stringify(requirement)}`,
          );
        } else if (requirementSet && !requirementSet.has(requirement)) {
          issues.push(`${path} references unknown requirement ${requirement}`);
        }
      }
    }
    if (Array.isArray(currentTask.surfaces)) {
      if (currentTask.surfaces.length === 0) {
        issues.push(`${path}.surfaces must not be empty`);
      }
      for (const surface of currentTask.surfaces) {
        if (!surfaceSet.has(surface)) {
          issues.push(`${path} references unknown surface ${surface}`);
        }
      }
    }
    if (typeof currentTask.verify === 'string') {
      if (!Object.hasOwn(verifierAllowlist, currentTask.verify)) {
        issues.push(`${path} references unknown verifier ${currentTask.verify}`);
      }
    }
    tasks.push(currentTask);
    currentTask = undefined;
    metadataWindowOpen = false;
  }

  for (const [zeroBasedLine, line] of markdown.split(/\r?\n/u).entries()) {
    const lineNumber = zeroBasedLine + 1;
    const trackMatch = line.match(
      /^##\s+(\d+)\.\s+Track:\s+([a-z0-9]+(?:-[a-z0-9]+)*)\s+\(depends:\s*(none|[a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)\)\s*$/u,
    );
    if (trackMatch) {
      finalizeTask();
      const number = Number(trackMatch[1]);
      const name = trackMatch[2];
      const depends =
        trackMatch[3] === 'none'
          ? []
          : trackMatch[3].split(',').map((value) => value.trim());
      if (trackNumbers.has(number)) issues.push(`duplicate track number ${number}`);
      if (trackNames.has(name)) issues.push(`duplicate track name ${name}`);
      trackNumbers.add(number);
      trackNames.add(name);
      currentTrack = { number, name, depends, line: lineNumber };
      tracks.push(currentTrack);
      continue;
    }

    const taskMatch = line.match(/^- \[([ xX])\]\s+(\d+\.\d+)\s+(.\S|\S.*)$/u);
    if (taskMatch) {
      finalizeTask();
      const id = taskMatch[2];
      if (!currentTrack) {
        issues.push(`task ${id} at line ${lineNumber} is outside a Track`);
      } else if (!id.startsWith(`${currentTrack.number}.`)) {
        issues.push(`task ${id} does not belong to track ${currentTrack.number}`);
      }
      if (taskIds.has(id)) issues.push(`duplicate task id ${id}`);
      taskIds.add(id);
      currentTask = {
        id,
        done: taskMatch[1].toLowerCase() === 'x',
        description: taskMatch[3].trim(),
        track: currentTrack?.name,
        line: lineNumber,
      };
      metadataWindowOpen = true;
      continue;
    }

    const metadataMatch = line.match(
      /^\s{2}- (requirements|surfaces|verify):\s*(.+?)\s*$/u,
    );
    if (metadataMatch) {
      if (!currentTask) {
        issues.push(`orphan ${metadataMatch[1]} metadata at line ${lineNumber}`);
        continue;
      }
      if (!metadataWindowOpen) {
        issues.push(
          `task ${currentTask.id}.${metadataMatch[1]} must be adjacent to its checkbox`,
        );
      }
      const field = metadataMatch[1];
      if (currentTask[field] !== undefined) {
        issues.push(`task ${currentTask.id} has duplicate ${field} metadata`);
        continue;
      }
      const value = parseJsonMetadata(
        metadataMatch[2],
        `task ${currentTask.id}.${field}`,
        issues,
      );
      if (field === 'verify') {
        if (typeof value !== 'string' || value.trim().length === 0) {
          issues.push(`task ${currentTask.id}.verify must be a non-empty JSON string`);
        } else {
          currentTask.verify = value;
        }
      } else {
        currentTask[field] = readStringArray(
          value,
          `task ${currentTask.id}.${field}`,
          issues,
          { required: true },
        );
      }
      continue;
    }

    if (/^- \[[^\]]*\]/u.test(line)) {
      issues.push(`malformed task checkbox at line ${lineNumber}`);
    }
    if (currentTask && line.trim() !== '' && !line.startsWith('  <!--')) {
      metadataWindowOpen = false;
    }
  }
  finalizeTask();

  if (tracks.length === 0) issues.push('tasks.md must contain at least one Track');
  if (tasks.length === 0) issues.push('tasks.md must contain at least one task checkbox');
  validateTrackGraph(tracks, issues);
  validateRequirementTrackCoupling(tracks, tasks, issues);

  if (issues.length > 0) throw new MetadataValidationError('tasks.md', issues);
  return { tracks, tasks };
}

export function normalizeRequirementName(name) {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function collectRequirementIdsFromDirectory(directory, ids) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    const specPath = join(directory, entry, 'spec.md');
    if (!existsSync(specPath) || !statSync(specPath).isFile()) continue;
    const text = readFileSync(specPath, 'utf8');
    for (const match of text.matchAll(/^### Requirement:\s+(.+?)\s*$/gmu)) {
      ids.add(`${entry}/${normalizeRequirementName(match[1])}`);
    }
  }
}

export function collectRequirementIds(repoRoot, changeName) {
  const ids = new Set();
  collectRequirementIdsFromDirectory(join(repoRoot, 'openspec', 'specs'), ids);
  collectRequirementIdsFromDirectory(
    join(repoRoot, 'openspec', 'changes', changeName, 'specs'),
    ids,
  );
  return ids;
}

function normalizeRegistryInventory(inventory) {
  if (!inventory) return undefined;
  const operationIds = new Set(inventory.operationIds ?? []);
  let toolByOperationId;
  if (inventory.toolByOperationId !== undefined) {
    toolByOperationId = new Map(
      inventory.toolByOperationId instanceof Map
        ? inventory.toolByOperationId
        : Object.entries(inventory.toolByOperationId),
    );
  }
  let differenceKindsByOperationId;
  if (inventory.differenceKindsByOperationId !== undefined) {
    const entries =
      inventory.differenceKindsByOperationId instanceof Map
        ? [...inventory.differenceKindsByOperationId]
        : Object.entries(inventory.differenceKindsByOperationId);
    differenceKindsByOperationId = new Map(
      entries.map(([operationId, kinds]) => [operationId, new Set(kinds)]),
    );
  }
  const excludedOperationIds =
    inventory.excludedOperationIds === undefined && toolByOperationId
      ? new Set(
          [...operationIds].filter(
            (operationId) => !toolByOperationId.has(operationId),
          ),
        )
      : new Set(inventory.excludedOperationIds ?? []);
  return {
    operationIds,
    toolIds: new Set(inventory.toolIds ?? []),
    toolByOperationId,
    excludedOperationIds,
    differenceKindsByOperationId,
  };
}

function unwrapStaticExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name) {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function directProperty(object, name) {
  return object.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === name,
  );
}

function staticStringProperty(object, name, subject, issues) {
  const property = directProperty(object, name);
  if (!property) {
    issues.push(`${subject}.${name} must be declared directly`);
    return undefined;
  }
  const initializer = unwrapStaticExpression(property.initializer);
  if (!ts.isStringLiteral(initializer)) {
    issues.push(`${subject}.${name} must be a static string literal`);
    return undefined;
  }
  return initializer.text;
}

function staticArrayExpression(expression, sourceFile, subject, issues) {
  const initializer = unwrapStaticExpression(expression);
  if (ts.isArrayLiteralExpression(initializer)) return initializer;
  if (ts.isIdentifier(initializer)) {
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find(
        (candidate) =>
          ts.isIdentifier(candidate.name) &&
          candidate.name.text === initializer.text,
      );
      const referencedInitializer = declaration?.initializer
        ? unwrapStaticExpression(declaration.initializer)
        : undefined;
      if (
        declaration &&
        (statement.declarationList.flags & ts.NodeFlags.Const) === 0
      ) {
        issues.push(`${subject} may reference only a top-level const array`);
        return undefined;
      }
      if (referencedInitializer && ts.isArrayLiteralExpression(referencedInitializer)) {
        return referencedInitializer;
      }
      if (declaration) break;
    }
  }
  issues.push(`${subject} must be a static array literal or a direct static-array constant`);
  return undefined;
}

function staticDifferenceKinds(expression, sourceFile, subject, issues) {
  const differences = staticArrayExpression(expression, sourceFile, subject, issues);
  if (!differences) return [];
  const kinds = [];
  differences.elements.forEach((element, index) => {
    const difference = unwrapStaticExpression(element);
    const differenceSubject = `${subject}[${index}]`;
    if (!ts.isObjectLiteralExpression(difference)) {
      issues.push(`${differenceSubject} must be a static object literal`);
      return;
    }
    if (difference.properties.some((property) => !ts.isPropertyAssignment(property))) {
      issues.push(`${differenceSubject} must contain only direct property assignments`);
      return;
    }
    const kind = staticStringProperty(difference, 'kind', differenceSubject, issues);
    if (kind) kinds.push(kind);
  });
  if (new Set(kinds).size !== kinds.length) {
    issues.push(`${subject} contains duplicate difference kinds`);
  }
  return kinds;
}

/** Load operation and MCP tool identities through a fail-closed static TS AST. */
export function loadRegistryInventory(repoRoot = DEFAULT_REPO_ROOT) {
  const contractsRoot = join(repoRoot, 'packages', 'contracts');
  const registryPath = join(
    contractsRoot,
    'src',
    'public-v1-operations.ts',
  );
  if (!existsSync(registryPath)) {
    throw new MetadataValidationError('public registry inventory', [
      `${relative(repoRoot, registryPath)} is required`,
    ]);
  }

  const source = readFileSync(registryPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    registryPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues = sourceFile.parseDiagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  );

  let registryDeclaration;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    registryDeclaration = statement.declarationList.declarations.find(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'PUBLIC_V1_OPERATIONS',
    );
    if (registryDeclaration) break;
  }

  const initializer = registryDeclaration?.initializer
    ? unwrapStaticExpression(registryDeclaration.initializer)
    : undefined;
  if (
    !initializer ||
    !ts.isCallExpression(initializer) ||
    !ts.isIdentifier(initializer.expression) ||
    initializer.expression.text !== 'definePublicV1Operations'
  ) {
    issues.push(
      'PUBLIC_V1_OPERATIONS must be a direct definePublicV1Operations(...) call',
    );
  }

  const inventoryArgument =
    initializer && ts.isCallExpression(initializer) && initializer.arguments[0]
      ? unwrapStaticExpression(initializer.arguments[0])
      : undefined;
  if (!inventoryArgument || !ts.isArrayLiteralExpression(inventoryArgument)) {
    issues.push('definePublicV1Operations must receive a static array literal');
  }

  const operationIds = [];
  const toolIds = [];
  const toolByOperationId = new Map();
  const excludedOperationIds = [];
  const differenceKindsByOperationId = new Map();
  if (inventoryArgument && ts.isArrayLiteralExpression(inventoryArgument)) {
    inventoryArgument.elements.forEach((element, index) => {
      const operation = unwrapStaticExpression(element);
      const subject = `PUBLIC_V1_OPERATIONS[${index}]`;
      if (!ts.isObjectLiteralExpression(operation)) {
        issues.push(`${subject} must be a static object literal`);
        return;
      }
      const operationId = staticStringProperty(operation, 'id', subject, issues);
      if (operationId) operationIds.push(operationId);

      const mcpProperty = directProperty(operation, 'mcp');
      const mcp = mcpProperty
        ? unwrapStaticExpression(mcpProperty.initializer)
        : undefined;
      if (!mcp || !ts.isObjectLiteralExpression(mcp)) {
        issues.push(`${subject}.mcp must be a static object literal`);
        return;
      }
      if (mcp.properties.some((property) => !ts.isPropertyAssignment(property))) {
        issues.push(`${subject}.mcp must contain only direct property assignments`);
      }
      const toolProperty = directProperty(mcp, 'tool');
      const exclusionProperty = directProperty(mcp, 'excluded');
      if (toolProperty && exclusionProperty) {
        issues.push(`${subject}.mcp cannot declare both tool and excluded`);
      } else if (toolProperty) {
        const tool = staticStringProperty(mcp, 'tool', `${subject}.mcp`, issues);
        if (tool) {
          toolIds.push(tool);
          if (operationId) toolByOperationId.set(operationId, tool);
        }
        const differencesProperty = directProperty(mcp, 'differences');
        if (!differencesProperty) {
          issues.push(`${subject}.mcp.differences must be declared directly`);
        } else if (operationId) {
          differenceKindsByOperationId.set(
            operationId,
            new Set(
              staticDifferenceKinds(
                differencesProperty.initializer,
                sourceFile,
                `${subject}.mcp.differences`,
                issues,
              ),
            ),
          );
        }
      } else if (exclusionProperty) {
        staticStringProperty(mcp, 'excluded', `${subject}.mcp`, issues);
        if (operationId) excludedOperationIds.push(operationId);
      } else {
        issues.push(`${subject}.mcp must declare a static tool or exclusion`);
      }
    });
  }

  if (operationIds.length === 0) {
    issues.push('PUBLIC_V1_OPERATIONS must contain at least one operation');
  }
  if (new Set(operationIds).size !== operationIds.length) {
    issues.push('PUBLIC_V1_OPERATIONS contains duplicate operation ids');
  }
  if (new Set(toolIds).size !== toolIds.length) {
    issues.push('PUBLIC_V1_OPERATIONS contains duplicate MCP tool ids');
  }
  if (issues.length > 0) {
    throw new MetadataValidationError('public registry inventory', issues);
  }
  return {
    operationIds: new Set(operationIds),
    toolIds: new Set(toolIds),
    toolByOperationId,
    excludedOperationIds: new Set(excludedOperationIds),
    differenceKindsByOperationId,
  };
}

function validateIdentifierArray(
  values,
  { path, kind, planned, phase, registry },
  issues,
) {
  const pattern =
    kind === 'operation'
      ? /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/u
      : /^[a-z][a-z0-9_]*$/u;
  const known = kind === 'operation' ? registry?.operationIds : registry?.toolIds;
  for (const value of values) {
    if (!pattern.test(value)) {
      issues.push(`${path} contains invalid ${kind} id ${JSON.stringify(value)}`);
      continue;
    }
    if (!known) continue;
    if (!planned && !known.has(value)) {
      issues.push(`${path} references unknown ${kind} id ${value}`);
    }
    if (planned && phase === 'verify' && !known.has(value)) {
      issues.push(`${path} planned ${kind} id ${value} is not implemented in the registry`);
    }
  }
}

function validateSurfaceEntry(key, entry, { phase, registry }, issues) {
  const path = `surfaces.${key}`;
  if (!requirePlainObject(entry, path, issues)) return undefined;
  addUnknownKeyIssues(
    entry,
    [
      'status',
      'reason',
      'protocolReason',
      'scope',
      'operationIds',
      'toolIds',
      'plannedOperationIds',
      'plannedToolIds',
    ],
    path,
    issues,
  );
  if (!SURFACE_STATUSES.includes(entry.status)) {
    issues.push(
      `${path}.status must be one of ${SURFACE_STATUSES.map(JSON.stringify).join(', ')}`,
    );
  }
  requireNonEmptyString(entry.reason, `${path}.reason`, issues);

  const selector = {
    operationIds: readStringArray(entry.operationIds, `${path}.operationIds`, issues),
    toolIds: readStringArray(entry.toolIds, `${path}.toolIds`, issues),
    plannedOperationIds: readStringArray(
      entry.plannedOperationIds,
      `${path}.plannedOperationIds`,
      issues,
    ),
    plannedToolIds: readStringArray(
      entry.plannedToolIds,
      `${path}.plannedToolIds`,
      issues,
    ),
  };
  const hasScope = entry.scope !== undefined;
  if (hasScope) requireNonEmptyString(entry.scope, `${path}.scope`, issues);
  const hasIds = Object.values(selector).some((values) => values.length > 0);
  const selected = hasScope || hasIds;
  if (hasScope && hasIds) {
    issues.push(`${path} must declare either scope or operation/tool ids, not both`);
  }

  if (entry.status === 'changed' || entry.status === 'derived') {
    if (!selected) {
      issues.push(
        `${path} with status ${entry.status} requires scope or operation/tool ids`,
      );
    }
  } else if (entry.status === 'excluded') {
    if (!selected) {
      issues.push(`${path} with status excluded requires scope or operation/tool ids`);
    }
    requireNonEmptyString(
      entry.protocolReason,
      `${path}.protocolReason`,
      issues,
    );
    if (
      selector.plannedOperationIds.length > 0 ||
      selector.plannedToolIds.length > 0
    ) {
      issues.push(`${path} may mark planned ids only when status is changed or derived`);
    }
    if (!hasScope && selector.operationIds.length === 0) {
      issues.push(
        `${path} with status excluded must identify stable operationIds or a scope`,
      );
    }
  } else if (selected) {
    issues.push(`${path} with status ${entry.status} must not declare a selector`);
  }

  if (
    entry.status !== 'excluded' &&
    entry.protocolReason !== undefined
  ) {
    issues.push(`${path}.protocolReason is only valid for status excluded`);
  }
  if (
    entry.status !== 'changed' &&
    entry.status !== 'derived' &&
    (selector.plannedOperationIds.length > 0 || selector.plannedToolIds.length > 0)
  ) {
    issues.push(`${path} may mark planned ids only when status is changed or derived`);
  }
  if (key === 'internalOnly' && entry.status === 'excluded') {
    issues.push('surfaces.internalOnly cannot be protocol-excluded');
  }

  const operationOverlap = selector.operationIds.filter((id) =>
    selector.plannedOperationIds.includes(id),
  );
  const toolOverlap = selector.toolIds.filter((id) =>
    selector.plannedToolIds.includes(id),
  );
  for (const id of operationOverlap) {
    issues.push(`${path} declares operation id ${id} as both existing and planned`);
  }
  for (const id of toolOverlap) {
    issues.push(`${path} declares tool id ${id} as both existing and planned`);
  }

  validateIdentifierArray(
    selector.operationIds,
    { path: `${path}.operationIds`, kind: 'operation', planned: false, phase, registry },
    issues,
  );
  validateIdentifierArray(
    selector.toolIds,
    { path: `${path}.toolIds`, kind: 'tool', planned: false, phase, registry },
    issues,
  );
  validateIdentifierArray(
    selector.plannedOperationIds,
    {
      path: `${path}.plannedOperationIds`,
      kind: 'operation',
      planned: true,
      phase,
      registry,
    },
    issues,
  );
  validateIdentifierArray(
    selector.plannedToolIds,
    {
      path: `${path}.plannedToolIds`,
      kind: 'tool',
      planned: true,
      phase,
      registry,
    },
    issues,
  );

  return { ...entry, ...selector };
}

function selectorOperations(entry, { includePlanned = true } = {}) {
  return new Set([
    ...(entry?.operationIds ?? []),
    ...(includePlanned ? entry?.plannedOperationIds ?? [] : []),
  ]);
}

function selectorTools(entry, { includePlanned = true } = {}) {
  return new Set([
    ...(entry?.toolIds ?? []),
    ...(includePlanned ? entry?.plannedToolIds ?? [] : []),
  ]);
}

function hasProtocolDifference(protocolDifferences, selector) {
  if (!Array.isArray(protocolDifferences)) return false;
  return protocolDifferences.some(
    (difference) =>
      isPlainObject(difference) &&
      (selector.operation !== undefined
        ? difference.operation === selector.operation
        : difference.scope === selector.scope),
  );
}

function validateMcpSelectorMapping(
  mcp,
  { phase, registry },
  issues,
) {
  if (!mcp || !['changed', 'derived', 'excluded'].includes(mcp.status)) return;
  const includePlanned = phase === 'verify';
  const operations = selectorOperations(mcp, { includePlanned });
  const tools = selectorTools(mcp, { includePlanned });
  if (mcp.status === 'excluded') {
    if (tools.size > 0) {
      issues.push('surfaces.mcp with status excluded must not select MCP tool ids');
    }
    if (!registry) return;
    const excludedOperations = registry.excludedOperationIds ?? new Set();
    const selectedOperations = mcp.scope
      ? new Set(registry.operationIds ?? [])
      : operations;
    for (const operationId of selectedOperations) {
      if (!excludedOperations.has(operationId)) {
        issues.push(
          `surfaces.mcp declares ${operationId} excluded, but the registry maps it to an MCP tool`,
        );
      }
    }
    return;
  }
  if (mcp.scope) return;
  if (operations.size === 0 && tools.size === 0) return;
  if (!registry?.toolByOperationId) {
    issues.push(
      'registry inventory must include operation-to-tool mappings for MCP selector validation',
    );
    return;
  }

  const operationByToolId = new Map(
    [...registry.toolByOperationId].map(([operationId, toolId]) => [
      toolId,
      operationId,
    ]),
  );
  for (const operationId of operations) {
    const expectedTool = registry.toolByOperationId.get(operationId);
    if (!expectedTool) {
      issues.push(
        `surfaces.mcp selects operation ${operationId}, which has no mapped MCP tool`,
      );
    } else if (!tools.has(expectedTool)) {
      issues.push(
        `surfaces.mcp operation ${operationId} requires mapped tool ${expectedTool}`,
      );
    }
  }
  for (const toolId of tools) {
    const expectedOperation = operationByToolId.get(toolId);
    if (!expectedOperation) {
      issues.push(`surfaces.mcp selects unknown operation mapping for tool ${toolId}`);
    } else if (!operations.has(expectedOperation)) {
      issues.push(
        `surfaces.mcp tool ${toolId} requires mapped operation ${expectedOperation}`,
      );
    }
  }
}

function validatePublicMcpSelectorSymmetry(
  surfaces,
  protocolDifferences,
  issues,
) {
  const publicV1 = surfaces.publicV1;
  const mcp = surfaces.mcp;
  const publicActive = ['changed', 'derived'].includes(publicV1?.status);
  const mcpActive = ['changed', 'derived'].includes(mcp?.status);
  const mcpExcluded = mcp?.status === 'excluded';
  if (mcpExcluded) {
    if (!publicActive) {
      issues.push(
        'an MCP exclusion requires a matching changed/derived Public V1 selector',
      );
      return;
    }
    if (Boolean(publicV1.scope) !== Boolean(mcp.scope)) {
      issues.push('Public V1 and excluded MCP selectors must use the same scope');
    }
    const publicOperations = selectorOperations(publicV1);
    const mcpOperations = selectorOperations(mcp);
    const asymmetricOperations = new Set([
      ...[...publicOperations].filter(
        (operationId) => !mcpOperations.has(operationId),
      ),
      ...[...mcpOperations].filter(
        (operationId) => !publicOperations.has(operationId),
      ),
    ]);
    for (const operationId of asymmetricOperations) {
      issues.push(
        `Public V1 and excluded MCP selectors disagree on ${operationId}`,
      );
    }
    return;
  }
  if (!mcpActive) return;

  if (!publicActive) {
    if (mcp.scope) {
      if (!hasProtocolDifference(protocolDifferences, { scope: 'all-existing' })) {
        issues.push(
          'an MCP-only registry-wide change requires an all-existing protocol difference explaining the inverse Public V1 decision',
        );
      }
      return;
    }
    for (const operationId of selectorOperations(mcp)) {
      if (!hasProtocolDifference(protocolDifferences, { operation: operationId })) {
        issues.push(
          `an MCP-only change for ${operationId} requires a matching protocol difference explaining the inverse Public V1 decision`,
        );
      }
    }
    return;
  }

  if (Boolean(publicV1.scope) !== Boolean(mcp.scope)) {
    if (!hasProtocolDifference(protocolDifferences, { scope: 'all-existing' })) {
      issues.push(
        'asymmetric Public V1/MCP registry-wide selectors require an all-existing protocol difference',
      );
    }
  }

  const publicOperations = selectorOperations(publicV1);
  const mcpOperations = selectorOperations(mcp);
  const asymmetricOperations = new Set([
    ...[...publicOperations].filter((operationId) => !mcpOperations.has(operationId)),
    ...[...mcpOperations].filter((operationId) => !publicOperations.has(operationId)),
  ]);
  for (const operationId of asymmetricOperations) {
    if (!hasProtocolDifference(protocolDifferences, { operation: operationId })) {
      issues.push(
        `Public V1/MCP selectors disagree on ${operationId} without a matching protocol difference`,
      );
    }
  }
}

function validateRegistryProtocolDifferences(
  surfaces,
  protocolDifferences,
  { phase, registry },
  issues,
) {
  if (!registry?.differenceKindsByOperationId || !Array.isArray(protocolDifferences)) {
    return;
  }

  const selectedOperations = new Set();
  let selectsAllExisting = false;
  for (const key of ['publicV1', 'mcp']) {
    const surface = surfaces[key];
    if (!surface || !['changed', 'derived', 'excluded'].includes(surface.status)) {
      continue;
    }
    if (surface.scope) selectsAllExisting = true;
    for (const operationId of selectorOperations(surface)) {
      selectedOperations.add(operationId);
    }
  }
  if (selectsAllExisting) {
    for (const operationId of registry.operationIds ?? []) {
      selectedOperations.add(operationId);
    }
  }

  const expectedKindsByOperation = new Map();
  for (const operationId of selectedOperations) {
    if (!registry.operationIds?.has(operationId)) continue;
    const expectedKinds = new Set(
      registry.differenceKindsByOperationId.get(operationId) ?? [],
    );
    if (registry.excludedOperationIds?.has(operationId)) {
      expectedKinds.add('mcp-exclusion');
    }
    expectedKindsByOperation.set(operationId, expectedKinds);
  }

  const declaredKindsByOperation = new Map();
  for (const difference of protocolDifferences) {
    if (
      !isPlainObject(difference) ||
      typeof difference.operation !== 'string' ||
      typeof difference.kind !== 'string'
    ) {
      continue;
    }
    let kinds = declaredKindsByOperation.get(difference.operation);
    if (!kinds) {
      kinds = new Set();
      declaredKindsByOperation.set(difference.operation, kinds);
    }
    kinds.add(difference.kind);
  }

  for (const [operationId, expectedKinds] of expectedKindsByOperation) {
    const declaredKinds = declaredKindsByOperation.get(operationId) ?? new Set();
    for (const kind of expectedKinds) {
      if (!declaredKinds.has(kind)) {
        issues.push(
          `registry protocol difference ${operationId}/${kind} is missing from protocolDifferences`,
        );
      }
    }
  }

  if (phase !== 'verify') return;
  for (const [operationId, declaredKinds] of declaredKindsByOperation) {
    if (!registry.operationIds?.has(operationId)) continue;
    const expectedKinds = expectedKindsByOperation.get(operationId);
    if (!expectedKinds) {
      issues.push(
        `protocolDifferences targets unselected registry operation ${operationId}`,
      );
      continue;
    }
    for (const kind of declaredKinds) {
      if (!expectedKinds.has(kind)) {
        issues.push(
          `protocolDifferences declares ${operationId}/${kind}, but the registry does not declare that operation difference`,
        );
      }
    }
  }
}

/** Validate one parsed surface-impact.json document. */
export function validateSurfaceImpactDocument(
  document,
  {
    changeName,
    phase = 'apply',
    registryInventory,
    verifierAllowlist = VERIFIER_ALLOWLIST,
  } = {},
) {
  const issues = [];
  if (!['propose', 'apply', 'verify'].includes(phase)) {
    throw new TypeError(`unsupported validation phase ${phase}`);
  }
  if (!requirePlainObject(document, 'surface-impact.json', issues)) {
    throw new MetadataValidationError('surface-impact.json', issues);
  }
  addUnknownKeyIssues(
    document,
    [
      'version',
      'change',
      'intent',
      'runtimeWireBehavior',
      'surfaces',
      'protocolDifferences',
      'verification',
    ],
    'surface-impact.json',
    issues,
  );
  if (document.version !== 1) issues.push('version must equal 1');
  if (requireNonEmptyString(document.change, 'change', issues) && changeName) {
    if (document.change !== changeName) {
      issues.push(`change must equal directory name ${JSON.stringify(changeName)}`);
    }
  }
  requireNonEmptyString(document.intent, 'intent', issues);
  if (!['changed', 'unchanged'].includes(document.runtimeWireBehavior)) {
    issues.push('runtimeWireBehavior must be "changed" or "unchanged"');
  }

  const registry = normalizeRegistryInventory(registryInventory);
  const surfaces = {};
  if (requirePlainObject(document.surfaces, 'surfaces', issues)) {
    addUnknownKeyIssues(document.surfaces, SURFACE_KEYS, 'surfaces', issues);
    for (const key of SURFACE_KEYS) {
      if (!Object.hasOwn(document.surfaces, key)) {
        issues.push(`surfaces.${key} is required`);
        continue;
      }
      surfaces[key] = validateSurfaceEntry(
        key,
        document.surfaces[key],
        { phase, registry },
        issues,
      );
    }
  }

  const publicV1Status = surfaces.publicV1?.status;
  const mcpStatus = surfaces.mcp?.status;
  if (
    ['changed', 'derived'].includes(publicV1Status) &&
    !['changed', 'derived', 'excluded'].includes(mcpStatus)
  ) {
    issues.push(
      'a changed/derived Public V1 surface requires MCP changed/derived or a reasoned exclusion',
    );
  }

  const allExistingOperations = new Set(registry?.operationIds ?? []);
  const allPlannedOperations = new Set();
  for (const surface of Object.values(surfaces)) {
    for (const id of surface?.plannedOperationIds ?? []) allPlannedOperations.add(id);
  }

  const protocolDifferences = document.protocolDifferences;
  if (!Array.isArray(protocolDifferences)) {
    issues.push('protocolDifferences must be an array');
  } else {
    const seen = new Set();
    for (const [index, difference] of protocolDifferences.entries()) {
      const path = `protocolDifferences[${index}]`;
      if (!requirePlainObject(difference, path, issues)) continue;
      addUnknownKeyIssues(
        difference,
        ['operation', 'scope', 'kind', 'detail'],
        path,
        issues,
      );
      const hasOperation = difference.operation !== undefined;
      const hasScope = difference.scope !== undefined;
      if (hasOperation === hasScope) {
        issues.push(`${path} must declare exactly one of operation or scope`);
      }
      const operationValid = hasOperation
        ? requireNonEmptyString(
            difference.operation,
            `${path}.operation`,
            issues,
          )
        : false;
      if (hasScope && difference.scope !== 'all-existing') {
        issues.push(`${path}.scope must equal "all-existing"`);
      }
      const kindValid = requireNonEmptyString(difference.kind, `${path}.kind`, issues);
      requireNonEmptyString(difference.detail, `${path}.detail`, issues);
      if (operationValid && !/^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/u.test(difference.operation)) {
        issues.push(`${path}.operation is not a stable operation id`);
      }
      if (kindValid && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(difference.kind)) {
        issues.push(`${path}.kind must be kebab-case`);
      }
      if (operationValid && registry) {
        const isExisting = allExistingOperations.has(difference.operation);
        const isPlanned = allPlannedOperations.has(difference.operation);
        if (!isExisting && !(phase !== 'verify' && isPlanned)) {
          issues.push(`${path}.operation references unknown operation id ${difference.operation}`);
        }
      }
      const target = hasOperation
        ? `operation:${difference.operation}`
        : `scope:${difference.scope}`;
      const identity = `${target}\u0000${difference.kind}`;
      if (seen.has(identity)) {
        issues.push(`${path} duplicates target/kind ${target}/${difference.kind}`);
      }
      seen.add(identity);
    }
  }

  validateMcpSelectorMapping(surfaces.mcp, { phase, registry }, issues);
  validatePublicMcpSelectorSymmetry(
    surfaces,
    protocolDifferences,
    issues,
  );
  validateRegistryProtocolDifferences(
    surfaces,
    protocolDifferences,
    { phase, registry },
    issues,
  );

  for (const key of PUBLIC_SURFACE_KEYS) {
    if (surfaces[key]?.status !== 'excluded') continue;
    const exclusionDifferences = Array.isArray(protocolDifferences)
      ? protocolDifferences.filter(
          (difference) =>
            isPlainObject(difference) &&
            typeof difference.kind === 'string' &&
            difference.kind.includes('exclusion'),
        )
      : [];
    if (surfaces[key].scope) {
      if (
        !exclusionDifferences.some(
          (difference) => difference.scope === 'all-existing',
        )
      ) {
        issues.push(
          `surfaces.${key} is registry-wide excluded but has no matching all-existing exclusion`,
        );
      }
      continue;
    }
    for (const operationId of surfaces[key].operationIds) {
      if (
        !exclusionDifferences.some(
          (difference) => difference.operation === operationId,
        )
      ) {
        issues.push(
          `surfaces.${key} excludes ${operationId} but has no matching protocol exclusion`,
        );
      }
    }
  }

  if (!requirePlainObject(document.verification, 'verification', issues)) {
    // The helper already added the structural issue.
  } else {
    addUnknownKeyIssues(
      document.verification,
      ['id', 'requiresWireCompatibilityFixture'],
      'verification',
      issues,
    );
    if (
      requireNonEmptyString(document.verification.id, 'verification.id', issues) &&
      !Object.hasOwn(verifierAllowlist, document.verification.id)
    ) {
      issues.push(`verification.id references unknown verifier ${document.verification.id}`);
    }
    if (typeof document.verification.requiresWireCompatibilityFixture !== 'boolean') {
      issues.push('verification.requiresWireCompatibilityFixture must be a boolean');
    }
    if (
      document.runtimeWireBehavior === 'changed' &&
      document.verification.requiresWireCompatibilityFixture !== true
    ) {
      issues.push(
        'changed runtime wire behavior requires a wire compatibility fixture',
      );
    }
  }

  if (issues.length > 0) {
    throw new MetadataValidationError('surface-impact.json', issues);
  }
  return { document, surfaces, registry };
}

function assertChangeName(changeName) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(changeName)) {
    throw new MetadataValidationError('change name', [
      `${JSON.stringify(changeName)} must be kebab-case`,
    ]);
  }
}

/** Validate both the sidecar and tasks metadata for one selected change. */
export function validateChangeMetadata(
  changeName,
  {
    repoRoot = DEFAULT_REPO_ROOT,
    phase = 'apply',
    registryInventory = loadRegistryInventory(repoRoot),
  } = {},
) {
  assertChangeName(changeName);
  const changeDirectory = join(repoRoot, 'openspec', 'changes', changeName);
  const sidecarPath = join(changeDirectory, 'surface-impact.json');
  const tasksPath = join(changeDirectory, 'tasks.md');
  const issues = [];
  let sidecar;
  let taskPlan;

  if (!existsSync(sidecarPath)) {
    issues.push(`${relative(repoRoot, sidecarPath)} is required`);
  } else {
    try {
      sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
      validateSurfaceImpactDocument(sidecar, {
        changeName,
        phase,
        registryInventory,
      });
    } catch (error) {
      if (error instanceof MetadataValidationError) issues.push(...error.issues);
      else issues.push(`surface-impact.json is invalid JSON: ${error.message}`);
    }
  }

  if (!existsSync(tasksPath)) {
    issues.push(`${relative(repoRoot, tasksPath)} is required`);
  } else {
    try {
      taskPlan = parseTaskMetadata(readFileSync(tasksPath, 'utf8'), {
        allowedRequirementIds: collectRequirementIds(repoRoot, changeName),
      });
    } catch (error) {
      if (error instanceof MetadataValidationError) issues.push(...error.issues);
      else issues.push(`tasks.md could not be validated: ${error.message}`);
    }
  }

  if (issues.length > 0) {
    throw new MetadataValidationError(`change ${changeName}`, issues);
  }
  return { changeName, changeDirectory, sidecar, taskPlan };
}

function normalizeChangedPath(repoRoot, filePath) {
  const path = isAbsolute(filePath) ? relative(repoRoot, filePath) : filePath;
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

export function changedOpenSpecChangeNames(
  changedPaths,
  { repoRoot = DEFAULT_REPO_ROOT } = {},
) {
  const names = new Set();
  for (const filePath of changedPaths) {
    const normalized = normalizeChangedPath(repoRoot, filePath);
    const match = normalized.match(/^openspec\/changes\/([^/]+)(?:\/|$)/u);
    if (!match || match[1] === 'archive') continue;
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(match[1])) names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * Validate only touched active changes. Untouched legacy changes deliberately do
 * not require a bulk sidecar/task-metadata backfill.
 */
export function validateChangedOpenSpecChanges(
  changedPaths,
  { repoRoot = DEFAULT_REPO_ROOT, phase = 'apply', registryInventory } = {},
) {
  const names = changedOpenSpecChangeNames(changedPaths, { repoRoot });
  const validated = [];
  for (const changeName of names) {
    validated.push(
      validateChangeMetadata(changeName, {
        repoRoot,
        phase,
        registryInventory:
          registryInventory === undefined
            ? loadRegistryInventory(repoRoot)
            : registryInventory,
      }),
    );
  }
  return validated;
}

/** Run a fixed allowlisted verifier with no shell evaluation. */
export function runVerifier(
  verifierId,
  {
    cwd = DEFAULT_REPO_ROOT,
    env = process.env,
    stdio = 'inherit',
    spawnSyncImpl = spawnSync,
    verifierAllowlist = VERIFIER_ALLOWLIST,
  } = {},
) {
  const verifier = Object.hasOwn(verifierAllowlist, verifierId)
    ? verifierAllowlist[verifierId]
    : undefined;
  if (!verifier) {
    throw new MetadataValidationError('verifier', [
      `unknown verifier id ${JSON.stringify(verifierId)}`,
    ]);
  }
  const results = [];
  for (const argv of verifier.argv) {
    const [command, ...args] = argv;
    const result = spawnSyncImpl(command, args, {
      cwd,
      env,
      stdio,
      shell: false,
    });
    results.push(result);
    if (result.error) {
      throw new Error(`verifier ${verifierId} could not start ${command}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `verifier ${verifierId} failed at ${command} with exit code ${String(result.status)}`,
      );
    }
  }
  return results;
}

export function runTaskVerifier(
  changeName,
  taskId,
  options = {},
) {
  const validated = validateChangeMetadata(changeName, {
    repoRoot: options.repoRoot,
    phase: options.phase ?? 'apply',
    registryInventory: options.registryInventory,
  });
  const task = validated.taskPlan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new MetadataValidationError('task verifier', [
      `unknown task id ${JSON.stringify(taskId)} in change ${changeName}`,
    ]);
  }
  const results = runVerifier(task.verify, {
    cwd: options.repoRoot ?? DEFAULT_REPO_ROOT,
    env: options.env,
    stdio: options.stdio,
    spawnSyncImpl: options.spawnSyncImpl,
    verifierAllowlist: options.verifierAllowlist,
  });
  return { task, results };
}

function readStagedPaths(repoRoot) {
  const result = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { cwd: repoRoot, encoding: 'utf8', shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git diff --cached failed');
  }
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

function parseCommonOptions(argv) {
  const positional = [];
  let phase = 'apply';
  let repoRoot = DEFAULT_REPO_ROOT;
  let staged = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--phase') {
      phase = argv[index + 1];
      index += 1;
    } else if (value === '--repo-root') {
      repoRoot = resolve(argv[index + 1]);
      index += 1;
    } else if (value === '--staged') {
      staged = true;
    } else if (value === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    } else if (value.startsWith('--')) {
      throw new Error(`unknown option ${value}`);
    } else {
      positional.push(value);
    }
  }
  return { positional, phase, repoRoot, staged };
}

function printUsage() {
  process.stderr.write(
    [
      'Usage:',
      '  node scripts/openspec-metadata.mjs validate-change <change> --phase propose|apply|verify',
      '  node scripts/openspec-metadata.mjs validate-diff [--staged] [changed paths...]',
      '  node scripts/openspec-metadata.mjs run-task <change> <task-id>',
      '  node scripts/openspec-metadata.mjs run-verifier <verifier-id>',
      '  node scripts/openspec-metadata.mjs list-verifiers',
      '',
    ].join('\n'),
  );
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return command ? 0 : 2;
  }
  if (command === 'list-verifiers') {
    const listed = Object.fromEntries(
      Object.entries(VERIFIER_ALLOWLIST).map(([id, verifier]) => [
        id,
        { description: verifier.description, argv: verifier.argv },
      ]),
    );
    process.stdout.write(`${JSON.stringify(listed, null, 2)}\n`);
    return 0;
  }

  const { positional, phase, repoRoot, staged } = parseCommonOptions(rest);
  if (command === 'validate-change') {
    if (positional.length !== 1) throw new Error('validate-change requires one change name');
    const result = validateChangeMetadata(positional[0], { repoRoot, phase });
    process.stdout.write(
      `Validated ${result.changeName}: ${result.taskPlan.tasks.length} tasks (${phase}).\n`,
    );
    return 0;
  }
  if (command === 'validate-diff') {
    const paths = [...positional];
    if (staged) paths.push(...readStagedPaths(repoRoot));
    const results = validateChangedOpenSpecChanges(paths, { repoRoot, phase });
    process.stdout.write(
      `Validated ${results.length} touched OpenSpec change(s): ${results
        .map((result) => result.changeName)
        .join(', ') || 'none'}.\n`,
    );
    return 0;
  }
  if (command === 'run-task') {
    if (positional.length !== 2) throw new Error('run-task requires a change and task id');
    const result = runTaskVerifier(positional[0], positional[1], {
      repoRoot,
      phase,
    });
    process.stdout.write(`Verifier ${result.task.verify} passed for task ${result.task.id}.\n`);
    return 0;
  }
  if (command === 'run-verifier') {
    if (positional.length !== 1) throw new Error('run-verifier requires one verifier id');
    runVerifier(positional[0], { cwd: repoRoot });
    process.stdout.write(`Verifier ${positional[0]} passed.\n`);
    return 0;
  }
  throw new Error(`unknown command ${command}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
