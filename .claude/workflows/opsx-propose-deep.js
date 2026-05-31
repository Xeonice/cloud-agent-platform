export const meta = {
  name: 'opsx-propose-deep',
  description: 'Deep-research OpenSpec propose: parallel research fan-out, then testable specs and track-annotated tasks',
  whenToUse: 'Invoked by the openspec-propose skill when a change warrants real research before artifacts are written.',
  phases: [
    { title: 'Research', detail: 'parallel web + codebase + archive scan' },
    { title: 'Synthesize', detail: 'merge routes into research-brief.md' },
    { title: 'Artifacts', detail: 'proposal -> specs (testable) -> tasks (track-annotated)' },
  ],
}

// args: { changeName, changeDir, idea } — passed verbatim from the skill.
const { changeName, changeDir, idea } = args || {}
if (!changeName || !changeDir) {
  throw new Error('opsx-propose-deep requires args { changeName, changeDir, idea }')
}

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['route', 'findings'],
  properties: {
    route: { type: 'string', enum: ['web', 'codebase', 'archive'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence', 'relevance'],
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'URL, file:line, or change name backing the claim' },
          relevance: { type: 'string', description: 'why this matters for the proposal' },
        },
      },
    },
  },
}

// ── Phase 1: parallel research fan-out (spec: "research routes run in parallel") ──
phase('Research')
const routePrompts = {
  web: `Research external practices, libraries, and prior art relevant to this change idea:\n"""${idea || changeName}"""\nUse web search across multiple angles (competitors, ecosystem libs, best practices). Return route="web".`,
  codebase: `Scan THIS repository for existing architecture, integration points, and reusable patterns relevant to:\n"""${idea || changeName}"""\nCite concrete file:line evidence. Return route="codebase".`,
  archive: `Scan openspec/changes/archive for prior changes similar to:\n"""${idea || changeName}"""\nReport how they were structured and what to reuse or avoid. Return route="archive".`,
}
const routes = await parallel(
  Object.entries(routePrompts).map(([route, prompt]) => () =>
    agent(prompt, { label: `research:${route}`, phase: 'Research', schema: BRIEF_SCHEMA })
  )
)
const research = routes.filter(Boolean)

// ── Phase 2: synthesize into research-brief.md (spec: "research brief is produced before proposal") ──
phase('Synthesize')
await agent(
  `Synthesize these research findings into a markdown brief and WRITE it to ${changeDir}/research-brief.md.\n` +
  `The brief MUST contain a section per route (Web / Codebase / Archive) attributing each finding to its route, ` +
  `followed by a "Implications for the proposal" section.\n\nFindings (JSON):\n${JSON.stringify(research, null, 2)}`,
  { label: 'synthesize:brief', phase: 'Synthesize' }
)

// ── Phase 3: artifacts in dependency order (proposal -> specs -> tasks) ──
// Sequential by necessity: spec-driven dependency graph (proposal unlocks specs+design; tasks needs both).
phase('Artifacts')
await agent(
  `Read ${changeDir}/research-brief.md. Run \`openspec instructions proposal --change "${changeName}" --json\`, ` +
  `follow its template, and write ${changeDir}/proposal.md grounded in the brief. Do NOT copy context/rules blocks into the file.`,
  { label: 'artifact:proposal', phase: 'Artifacts' }
)
// specs: testable scenarios (spec: "generated scenarios are verifiable")
await agent(
  `Run \`openspec instructions specs --change "${changeName}" --json\` and create one spec file per capability in the proposal.\n` +
  `CRITICAL: every requirement has at least one \`#### Scenario\` (exactly 4 hashtags) in WHEN/THEN form. ` +
  `Reject non-observable criteria ("fast", "clean") unless given a measurable threshold — every scenario must be independently checkable by the verify phase.`,
  { label: 'artifact:specs', phase: 'Artifacts' }
)
// tasks: track-annotated draft (spec: "tasks carry track metadata")
await agent(
  `Run \`openspec instructions tasks --change "${changeName}" --json\` and write ${changeDir}/tasks.md.\n` +
  `Format groups as \`## N. Track: <kebab-name> (depends: <track>|none)\` per openspec/config.yaml rules.tasks. ` +
  `Each task \`- [ ] N.Y <desc>\`. Group by disjoint files/modules so tracks can run in parallel; co-locate tasks that edit a shared file. ` +
  `This is a best-effort DRAFT partition — the apply phase will correct it against real coupling.`,
  { label: 'artifact:tasks', phase: 'Artifacts' }
)

// Boundary guard (spec: "no schema or CLI mutation"): this workflow only ever
// writes files under changeDir / repo artifacts via agents; it never invokes a
// mutating openspec subcommand beyond `instructions`/`status` and never edits the
// CLI install or schema. Surfaced here as an explicit invariant for reviewers.
return {
  changeName,
  brief: `${changeDir}/research-brief.md`,
  routesCovered: research.map((r) => r.route),
  note: 'Artifacts generated from research; backbone (CLI/schema/dep-graph) untouched.',
}
