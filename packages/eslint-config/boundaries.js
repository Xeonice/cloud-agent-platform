/**
 * Boundary rules, derived at config-load time from the single declaration
 * source `docs/refactor/boundaries-manifest.json`.
 *
 * Topology (design D1): the manifest is read DIRECTLY here — no codegen, no
 * intermediate artifact, no rule data copied into this file. The other
 * consumer (the independent CI interpreter under `scripts/`) reads the same
 * JSON and derives its own execution; the two consumers never derive from each
 * other, and this module never reads the interpreter's output.
 *
 * Fail-closed (spec `boundary-lint-rules/lint-fails-closed-...`): a missing,
 * unparsable, or ruleless manifest — or any entry missing its `provenance` /
 * `change` provenance fields, or an exemption missing one of its three
 * reviewable fields — throws during config load, so lint exits non-zero.
 * Boundary rules are never silently absent while lint reports green.
 *
 * Usage from a workspace member's `eslint.config.js`:
 *
 *   import config from "@cap-console/eslint-config";
 *   import { boundaryConfigs } from "@cap-console/eslint-config/boundaries";
 *
 *   export default [
 *     ...config,
 *     ...boundaryConfigs({ packageDir: import.meta.dirname }),
 *   ];
 *
 * `packageDir` is the consuming package's identity: every manifest rule is
 * scoped to the packages it constrains (`appliesTo`), so a rule that
 * constrains another package emits nothing here.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

/** Repo-relative location of the single declaration source. */
const MANIFEST_REPO_PATH = "docs/refactor/boundaries-manifest.json";

/** Source extensions a boundary rule applies to inside a scan root. */
const SOURCE_EXTENSIONS = "{js,jsx,mjs,cjs,ts,tsx,mts,cts}";

const PREFIX = "[boundaries-manifest]";

/** Every error here is a config-load failure: lint must not run without rules. */
function fail(message) {
  throw new Error(`${PREFIX} ${message}`);
}

/**
 * Walk up from this module to the repository that carries the manifest. The
 * package is symlinked into each member's `node_modules` by pnpm; Node resolves
 * the realpath, so the ancestor walk lands in this repository, not the symlink.
 * The walk stops at the workspace root (`pnpm-workspace.yaml`) so a checkout
 * nested inside another checkout can never silently borrow the outer manifest.
 */
function resolveManifestPath() {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, MANIFEST_REPO_PATH);
    if (existsSync(candidate)) return candidate;
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      fail(
        `boundaries manifest not found: the workspace root ${dir} has no \`${MANIFEST_REPO_PATH}\`. ` +
          `The boundary rules are declared only there — lint refuses to run without them ` +
          `instead of passing with the rules silently skipped.`,
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fail(
    `boundaries manifest not found: no \`${MANIFEST_REPO_PATH}\` in any ancestor of ${start}. ` +
      `The boundary rules are declared only there — lint refuses to run without them ` +
      `instead of passing with the rules silently skipped.`,
  );
  return "";
}

function readManifest(manifestPath) {
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (cause) {
    fail(`boundaries manifest at ${manifestPath} is unreadable: ${cause.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    fail(`boundaries manifest at ${manifestPath} is not parsable JSON: ${cause.message}`);
  }
  return undefined;
}

function entryLabel(entry) {
  return entry?.id ?? entry?.path ?? entry?.name ?? "<unnamed>";
}

function requireStringField(entry, field, where) {
  const value = entry?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    fail(
      `${where} entry "${entryLabel(entry)}" is missing the required \`${field}\` field. ` +
        `Every manifest entry carries its provenance (工件02 表行) and the change that landed it.`,
    );
  }
}

/** `provenance` + `change` are mandatory on every manifest entry. */
function requireProvenance(entry, where) {
  requireStringField(entry, "provenance", where);
  requireStringField(entry, "change", where);
}

/** Exemptions/allowlist entries are three-field reviewable data. */
function requireExemptionFields(entry, where) {
  if (entry?.path === undefined && entry?.name === undefined) {
    fail(`${where} exemption entry is missing its locator (\`path\` or \`name\`).`);
  }
  for (const field of ["reason", "owner", "change"]) {
    const value = entry?.[field];
    if (typeof value !== "string" || value.trim() === "") {
      fail(
        `${where} exemption "${entryLabel(entry)}" is missing the required \`${field}\` field. ` +
          `An exemption is data with exactly three reviewable fields (reason/owner/change); ` +
          `a malformed one is neither applied nor dropped silently.`,
      );
    }
  }
}

function requireList(entry, field, where) {
  const value = entry?.[field];
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${where} entry "${entryLabel(entry)}" has an empty or missing \`${field}\` list.`);
  }
  return value;
}

/**
 * Validate the whole manifest once, at load: shape, provenance, exemptions, and
 * the "incorporated by reference" contract (an `existing-gate` entry must not
 * carry executable rule data — that would be the second implementation the
 * registration exists to prevent).
 */
function validateManifest(manifest, manifestPath) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(`boundaries manifest at ${manifestPath} must be a JSON object.`);
  }
  const packageRules = Array.isArray(manifest.packageRules) ? manifest.packageRules : [];
  const seamRules = Array.isArray(manifest.seamRules) ? manifest.seamRules : [];
  const securitySeams = Array.isArray(manifest.securitySeams) ? manifest.securitySeams : [];

  let enforceable = 0;
  for (const rule of packageRules) {
    requireProvenance(rule, "packageRules");
    if (rule.enforcement === "existing-gate") {
      if (rule.forbid !== undefined || rule.appliesTo !== undefined) {
        fail(
          `packageRules entry "${entryLabel(rule)}" is registered as \`existing-gate\` yet carries ` +
            `executable rule data (\`forbid\`/\`appliesTo\`). Already-landed rules are incorporated ` +
            `by reference only — deriving a second execution is exactly what the registration forbids.`,
        );
      }
      requireList(rule, "enforcedBy", "packageRules");
      continue;
    }
    if (rule.enforcement !== "manifest") {
      fail(
        `packageRules entry "${entryLabel(rule)}" has unknown \`enforcement\` value ` +
          `${JSON.stringify(rule.enforcement)} (expected "manifest" or "existing-gate").`,
      );
    }
    requireList(rule, "appliesTo", "packageRules");
    const forbid = rule.forbid;
    if (
      forbid === null ||
      typeof forbid !== "object" ||
      ((forbid.packagePatterns ?? []).length === 0 && (forbid.paths ?? []).length === 0)
    ) {
      fail(
        `packageRules entry "${entryLabel(rule)}" is manifest-enforced but declares no forbidden ` +
          `\`packagePatterns\`/\`paths\`; an empty rule would lint green while enforcing nothing.`,
      );
    }
    enforceable += 1;
  }

  for (const rule of seamRules) {
    requireProvenance(rule, "seamRules");
    if (rule.enforcement === "existing-gate") {
      if (rule.egress !== undefined || rule.target !== undefined) {
        fail(
          `seamRules entry "${entryLabel(rule)}" is registered as \`existing-gate\` yet carries ` +
            `executable rule data (\`egress\`/\`target\`).`,
        );
      }
      requireList(rule, "enforcedBy", "seamRules");
      continue;
    }
    if (rule.enforcement !== "manifest") {
      fail(
        `seamRules entry "${entryLabel(rule)}" has unknown \`enforcement\` value ` +
          `${JSON.stringify(rule.enforcement)} (expected "manifest" or "existing-gate").`,
      );
    }
    requireList(rule, "appliesTo", "seamRules");
    // Shape validation happens here, not when a package happens to be in
    // scope, so a malformed seam rule is red for every consumer.
    if (rule.egress !== undefined) {
      if ((rule.egress.calls ?? []).length === 0 && (rule.egress.constructors ?? []).length === 0) {
        fail(
          `seamRules entry "${entryLabel(rule)}" declares no \`egress.calls\`/\`egress.constructors\` ` +
            `to discover; an empty discovery set would lint green while enforcing nothing.`,
        );
      }
    } else if (rule.target !== undefined) {
      if ((rule.target.specifiers ?? []).length === 0 && !rule.target.path) {
        fail(
          `seamRules entry "${entryLabel(rule)}" declares neither \`target.specifiers\` nor ` +
            `\`target.path\`; the restricted module cannot be derived.`,
        );
      }
    } else {
      fail(
        `seamRules entry "${entryLabel(rule)}" is manifest-enforced but declares neither ` +
          `\`egress\` (discovery scan) nor \`target\` (import restriction) data; ` +
          `an uninterpretable rule is a config-load failure, not a skip.`,
      );
    }
    for (const exemption of rule.exemptions ?? []) {
      requireExemptionFields(exemption, `seamRules ${entryLabel(rule)}`);
    }
    for (const allowed of rule.allowNames ?? []) {
      requireExemptionFields(allowed, `seamRules ${entryLabel(rule)} allowNames`);
    }
    enforceable += 1;
  }

  for (const seam of securitySeams) {
    requireProvenance(seam, "securitySeams");
  }

  if (enforceable === 0) {
    fail(
      `boundaries manifest at ${manifestPath} yields an empty rule set (no manifest-enforced ` +
        `packageRules or seamRules). Lint fails closed rather than running with no boundary rules.`,
    );
  }

  return { packageRules, seamRules };
}

/** Memoized per manifest path: one read + one validation per lint process. */
const manifestCache = new Map();

export function loadBoundariesManifest(manifestPath = resolveManifestPath()) {
  const resolved = path.resolve(manifestPath);
  const cached = manifestCache.get(resolved);
  if (cached) return cached;
  if (!existsSync(resolved)) {
    fail(
      `boundaries manifest not found at ${resolved}. The boundary rules are declared only there — ` +
        `lint refuses to run without them.`,
    );
  }
  const manifest = readManifest(resolved);
  const { packageRules, seamRules } = validateManifest(manifest, resolved);
  const repoRoot = path.resolve(path.dirname(resolved), "..", "..");
  const loaded = { manifest, packageRules, seamRules, manifestPath: resolved, repoRoot };
  manifestCache.set(resolved, loaded);
  return loaded;
}

/**
 * Map a manifest scan root (repo-relative, `*` segments allowed) onto a flat
 * config `files` pattern relative to the consuming package, or null when the
 * root constrains a different package.
 */
function filesPatternFor(scanRoot, packageSegments) {
  const rootSegments = String(scanRoot).split("/").filter(Boolean);
  const shared = Math.min(rootSegments.length, packageSegments.length);
  for (let i = 0; i < shared; i += 1) {
    if (rootSegments[i] === "*") continue;
    if (rootSegments[i] !== packageSegments[i]) return null;
  }
  const remainder = rootSegments.slice(packageSegments.length);
  const prefix = remainder.length > 0 ? `${remainder.join("/")}/` : "";
  return `${prefix}**/*.${SOURCE_EXTENSIONS}`;
}

function filesFor(scanRoots, packageSegments) {
  const patterns = [];
  for (const root of scanRoots) {
    const pattern = filesPatternFor(root, packageSegments);
    if (pattern !== null && !patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}

/** Repo-relative file → package-relative pattern, or null when out of package. */
function fileWithinPackage(repoRelPath, repoRoot, packageDir) {
  const absolute = path.resolve(repoRoot, repoRelPath);
  const relative = path.relative(packageDir, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function ruleMessage(rule) {
  const text = rule.message ?? rule.statement ?? rule.id;
  return `${text} [${rule.id} · ${rule.provenance}]`;
}

/**
 * Accumulator for restricted-import configs.
 *
 * ESLint merges config objects by rule id, so two manifest rules landing on the
 * same rule id and the same file scope must be merged into ONE options object —
 * otherwise the later one silently replaces the earlier one's patterns.
 */
function createRestrictedImportSink() {
  const buckets = new Map();
  return {
    add(ruleName, files, pattern, name) {
      const key = `${ruleName}::${files.join("|")}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.patterns.push(pattern);
        bucket.names.push(name);
        return;
      }
      buckets.set(key, { ruleName, files, patterns: [pattern], names: [name] });
    },
    configs() {
      return [...buckets.values()].map((bucket) => ({
        name: `boundaries/${bucket.names.join("+")}`,
        files: bucket.files,
        // typescript-eslint's variant is the only one that understands
        // `allowTypeImports`; registering the plugin object the shared config
        // already uses keeps this module usable on its own.
        ...(bucket.ruleName.startsWith("@typescript-eslint/")
          ? { plugins: { "@typescript-eslint": tseslint.plugin } }
          : {}),
        rules: { [bucket.ruleName]: ["error", { patterns: bucket.patterns }] },
      }));
    },
  };
}

/** P1–P8: package-name patterns (never filesystem zones), scoped by `appliesTo`. */
function addPackageRule(rule, context, sink) {
  if (rule.enforcement !== "manifest") return;
  const files = filesFor(rule.appliesTo, context.packageSegments);
  if (files.length === 0) return; // the rule constrains a different package
  const group = [
    ...(rule.forbid.packagePatterns ?? []),
    // A forbidden directory is derived on this side as a specifier-text
    // pattern (`docs/refactor/boundaries-manifest.json` → conventions
    // `forbid.paths`); the interpreter resolves specifiers instead.
    ...(rule.forbid.paths ?? []).map((dir) => `**/${dir}/**`),
  ];
  const allowTypeImports = rule.forbid.allowTypeImports === true;
  const pattern = { group, message: ruleMessage(rule) };
  if (allowTypeImports) pattern.allowTypeImports = true;
  sink.add(
    allowTypeImports ? "@typescript-eslint/no-restricted-imports" : "no-restricted-imports",
    files,
    pattern,
    rule.id,
  );
}

/**
 * S1: discovery-based egress. The selectors find every `fetch(...)` /
 * `new WebSocket(...)` under the scan root — the transport files are exempted
 * per-file afterwards, so the rule is never an enumeration of files to scan.
 */
function egressSeamConfigs(rule, context) {
  const files = filesFor(rule.appliesTo, context.packageSegments);
  if (files.length === 0) return [];
  const message = ruleMessage(rule);
  const calls = rule.egress.calls ?? [];
  const constructors = rule.egress.constructors ?? [];
  const receivers = rule.egress.receivers ?? [];
  if (calls.length === 0 && constructors.length === 0) {
    fail(`seamRules entry "${entryLabel(rule)}" declares no \`egress.calls\`/\`egress.constructors\`.`);
  }
  const selectors = [];
  const push = (selector) => selectors.push({ selector, message });
  for (const call of calls) {
    push(`CallExpression[callee.type="Identifier"][callee.name="${call}"]`);
    for (const receiver of receivers) {
      push(
        `CallExpression[callee.type="MemberExpression"][callee.object.name="${receiver}"][callee.property.name="${call}"]`,
      );
    }
  }
  for (const ctor of constructors) {
    push(`NewExpression[callee.type="Identifier"][callee.name="${ctor}"]`);
    for (const receiver of receivers) {
      push(
        `NewExpression[callee.type="MemberExpression"][callee.object.name="${receiver}"][callee.property.name="${ctor}"]`,
      );
    }
  }

  // Per-file exemptions: the designated transports (the same enumeration the
  // G8 CORS gate reads) plus the manifest's three-field exemption entries.
  const exemptFiles = [];
  for (const transport of rule.transports ?? []) {
    const withinPackage = fileWithinPackage(transport, context.repoRoot, context.packageDir);
    if (withinPackage && !exemptFiles.includes(withinPackage)) exemptFiles.push(withinPackage);
  }
  for (const exemption of rule.exemptions ?? []) {
    const withinPackage = fileWithinPackage(exemption.path, context.repoRoot, context.packageDir);
    if (withinPackage && !exemptFiles.includes(withinPackage)) exemptFiles.push(withinPackage);
  }

  const configs = [
    {
      name: `boundaries/${rule.id}`,
      files,
      rules: { "no-restricted-syntax": ["error", ...selectors] },
    },
  ];
  if (exemptFiles.length > 0) {
    configs.push({
      name: `boundaries/${rule.id}-exempt`,
      files: exemptFiles,
      rules: { "no-restricted-syntax": "off" },
    });
  }
  return configs;
}

/**
 * S2: components must not value-import the real transport's data-fetching
 * functions. `import type` and the manifest's registered non-fetching exports
 * are allowed; anything else — including newly added exports — is forbidden by
 * default, so widening the list means editing the manifest.
 */
function seamBypassPattern(rule, context, sink) {
  const files = filesFor(rule.appliesTo, context.packageSegments);
  if (files.length === 0) return [];
  const specifiers = [...(rule.target.specifiers ?? [])];
  // Derive the relative spelling of the same target module from its declared
  // path: everything past the source root the scan roots share with it.
  const targetPath = String(rule.target.path ?? "");
  if (targetPath !== "") {
    const targetSegments = targetPath.replace(/\.[^./]+$/, "").split("/");
    const rootSegments = String(rule.appliesTo[0]).split("/");
    let sharedLength = 0;
    while (
      sharedLength < targetSegments.length &&
      sharedLength < rootSegments.length &&
      targetSegments[sharedLength] === rootSegments[sharedLength]
    ) {
      sharedLength += 1;
    }
    const relativeSpelling = `**/${targetSegments.slice(sharedLength).join("/")}`;
    if (!specifiers.includes(relativeSpelling)) specifiers.push(relativeSpelling);
  }
  if (specifiers.length === 0) {
    fail(`seamRules entry "${entryLabel(rule)}" declares no \`target.specifiers\`/\`target.path\`.`);
  }
  const pattern = {
    group: specifiers,
    allowImportNames: (rule.allowNames ?? []).map((allowed) => allowed.name),
    message: ruleMessage(rule),
  };
  if (rule.allowTypeImports === true) pattern.allowTypeImports = true;
  sink.add("@typescript-eslint/no-restricted-imports", files, pattern, rule.id);
  return exemptionConfigs(rule, context, "@typescript-eslint/no-restricted-imports");
}

/**
 * Per-file exemptions declared as three-field manifest data.
 *
 * Both consumers read the tolerance from the SAME place: the CI interpreter is
 * forbidden by spec from reading ESLint's suppression file, so a debt recorded
 * only there would be invisible to it and the committed tree would be red.
 * Recording it here — once — keeps one debt in one ledger and keeps the two
 * loops agreeing on the same set of pre-existing sites.
 */
function exemptionConfigs(rule, context, ruleName) {
  const exemptFiles = [];
  for (const exemption of rule.exemptions ?? []) {
    const withinPackage = fileWithinPackage(exemption.path, context.repoRoot, context.packageDir);
    if (withinPackage && !exemptFiles.includes(withinPackage)) exemptFiles.push(withinPackage);
  }
  if (exemptFiles.length === 0) return [];
  return [
    {
      name: `boundaries/${rule.id}-exempt`,
      files: exemptFiles,
      rules: { [ruleName]: "off" },
    },
  ];
}

/**
 * Build the flat-config fragments this package is subject to.
 *
 * @param {{ packageDir: string, manifestPath?: string }} options
 * @returns {import("eslint").Linter.Config[]}
 */
export function boundaryConfigs({ packageDir, manifestPath } = {}) {
  if (typeof packageDir !== "string" || packageDir.trim() === "") {
    fail(
      `boundaryConfigs({ packageDir }) requires the consuming package's directory ` +
        `(pass \`import.meta.dirname\` from that package's eslint.config.js) — without it the ` +
        `rules cannot be scoped to the package the manifest constrains.`,
    );
  }
  const { packageRules, seamRules, repoRoot } = loadBoundariesManifest(
    manifestPath ?? resolveManifestPath(),
  );
  const resolvedPackageDir = path.resolve(packageDir);
  const packageRelative = path.relative(repoRoot, resolvedPackageDir);
  if (packageRelative.startsWith("..") || path.isAbsolute(packageRelative)) {
    fail(`packageDir ${resolvedPackageDir} is outside the repository root ${repoRoot}.`);
  }
  const context = {
    repoRoot,
    packageDir: resolvedPackageDir,
    packageSegments: packageRelative === "" ? [] : packageRelative.split(path.sep).filter(Boolean),
  };

  const sink = createRestrictedImportSink();
  const syntaxConfigs = [];

  for (const rule of packageRules) addPackageRule(rule, context, sink);

  for (const rule of seamRules) {
    if (rule.enforcement !== "manifest") continue;
    // Dispatch on the shape the manifest declares, not on a hard-coded id list.
    if (rule.egress !== undefined) {
      syntaxConfigs.push(...egressSeamConfigs(rule, context));
    } else if (rule.target !== undefined) {
      // The exemption fragments must come AFTER the restricted-import configs
      // the sink emits, or ESLint's later-wins merge would re-enable the rule
      // on the exempted files.
      syntaxConfigs.push(...seamBypassPattern(rule, context, sink));
    } else {
      fail(
        `seamRules entry "${entryLabel(rule)}" is manifest-enforced but declares neither ` +
          `\`egress\` (discovery scan) nor \`target\` (import restriction) data; ` +
          `an uninterpretable rule is a config-load failure, not a skip.`,
      );
    }
  }

  return [...sink.configs(), ...syntaxConfigs];
}

export default boundaryConfigs;
