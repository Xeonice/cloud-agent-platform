/**
 * Server-side skill preinstall allowlist (task-preinstall-skills).
 *
 * Maps an operator-selectable skill id to the PINNED, non-interactive installer
 * command run against the cloned workspace at provision time. The operator only
 * ever submits skill IDS (validated against this allowlist); the command text is
 * server-defined, so no operator free-text is ever executed as a command.
 *
 * Commands + target dirs are LIVE-VERIFIED in a real cap-aio sandbox (Track 1
 * spike, see the change's design.md "Live spike results"):
 *   - openspec → npx @fission-ai/openspec init --tools codex --force <ws>
 *     → drops `openspec/` + `.codex/skills/<name>/SKILL.md` (~6s)
 *   - bmad     → npx bmad-method install --directory <ws> --modules bmm
 *                --tools codex --yes → drops `_bmad/` + `.agents/skills` (~3s)
 * Both are codex-discovered workspace dirs (codex launches with `-C <ws>`).
 *
 * Each command is built as an argv array (no shell string interpolation of the
 * id) and ALWAYS reads stdin from /dev/null (the installers are non-interactive
 * but must not block on a TTY). Versions are PINNED for reproducibility, mirroring
 * the codex version-pin discipline; bump deliberately.
 */

/** A single allowlisted skill: how to install it into the workspace. */
export interface SkillInstaller {
  /** Operator-facing id (matches the frontend catalog). */
  readonly id: string;
  /** Human label for logs. */
  readonly label: string;
  /**
   * Build the installer command (argv) for a given workspace dir. Returned as an
   * argv array so the workspace path is passed as one argument and the skill id
   * is never shell-interpolated. The provider joins/escapes for `/v1/shell/exec`.
   */
  readonly command: (workspaceDir: string) => readonly string[];
}

/** Pinned versions — bump deliberately (live-verified at these majors). */
const BMAD_PKG = 'bmad-method@6.8.0';

/**
 * The allowlist, keyed by skill id. Only ids present here are ever executed.
 */
export const SKILL_ALLOWLIST: Readonly<Record<string, SkillInstaller>> = {
  openspec: {
    id: 'openspec',
    label: 'OpenSpec',
    // The `openspec` CLI is BAKED into the sandbox image (docker/aio-sandbox.
    // Dockerfile, OPENSPEC_VERSION) — it cannot be `npm i -g`'d at provision time
    // because the exec channel runs as the unprivileged `gem` user. So scaffold
    // the workspace with the baked CLI directly (`openspec init`): this both
    // drops `.codex/skills/*/SKILL.md` + `openspec/`, AND guarantees the same
    // `openspec` the skills shell out to is present on PATH at runtime (single
    // version source = the Dockerfile pin; no per-task npx fetch).
    command: (ws) => ['openspec', 'init', '--tools', 'codex', '--force', ws],
  },
  bmad: {
    id: 'bmad',
    label: 'BMAD',
    command: (ws) => [
      'npx',
      '-y',
      BMAD_PKG,
      'install',
      '--directory',
      ws,
      '--modules',
      'bmm',
      '--tools',
      'codex',
      '--yes',
    ],
  },
};

/** True when `id` is an allowlisted, installable skill. */
export function isAllowlistedSkill(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(SKILL_ALLOWLIST, id);
}

/** Resolve the installer for an id, or undefined when not allowlisted. */
export function resolveSkillInstaller(id: string): SkillInstaller | undefined {
  return isAllowlistedSkill(id) ? SKILL_ALLOWLIST[id] : undefined;
}
