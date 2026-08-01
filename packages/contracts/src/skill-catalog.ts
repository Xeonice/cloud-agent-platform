/**
 * THE declaration of which operator-selectable preinstall skills exist
 * (unlock-extension-axes D9, task-preinstall-skills).
 *
 * This id set previously lived twice, held together by a MUST-match comment:
 * the web catalog (`new-task-dialog.tsx` — ids + display copy) and the api
 * allowlist (`skill-allowlist.ts` — ids + pinned installer commands). An id
 * added on one side without the other was silently ignored at provision time.
 *
 * ONLY the id vocabulary is declared here — the DERIVED-legal split
 * (converge-contracts): display copy (labels, hints) stays web-side, installer
 * command construction stays api-side; both key their tables by these ids, so a
 * skill id cannot exist on one side without the other.
 */
export const SKILL_CATALOG_IDS = ['openspec', 'bmad'] as const;

export type SkillCatalogId = (typeof SKILL_CATALOG_IDS)[number];
