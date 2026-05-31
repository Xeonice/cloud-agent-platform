export const meta = {
  name: 'opsx-verify',
  description: 'Adversarial spec verification: enumerate requirements, static triage, high-risk dynamic + diverse-lens refutation, three-way routing',
  whenToUse: 'Run after apply to prove each spec requirement is satisfied. Also the precondition gate for opsx-archive.',
  phases: [
    { title: 'Enumerate', detail: 'collect every requirement across specs/**' },
    { title: 'Triage', detail: 'static verdict per requirement' },
    { title: 'Escalate', detail: 'diverse-lens refutation + dynamic test for risky/uncertain' },
    { title: 'Route', detail: 'unmet->tasks, defect->design, met->report; gap & scope checks' },
  ],
}

const { changeName, changeDir } = args || {}
if (!changeName || !changeDir) throw new Error('opsx-verify requires args { changeName, changeDir }')

const REQ_LIST = {
  type: 'object', additionalProperties: false, required: ['requirements'],
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['capability', 'name', 'scenarios'],
        properties: {
          capability: { type: 'string' },
          name: { type: 'string' },
          scenarios: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}
const TRIAGE = {
  type: 'object', additionalProperties: false,
  required: ['met', 'confidence', 'risk', 'evidence'],
  properties: {
    met: { type: 'boolean' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'high = multi-track, security, or data-mutating' },
    evidence: { type: 'string', description: 'file:line trace' },
  },
}
const REFUTE = {
  type: 'object', additionalProperties: false, required: ['lens', 'refuted', 'reason'],
  properties: {
    lens: { type: 'string' },
    refuted: { type: 'boolean', description: 'true = skeptic disproved that the requirement is satisfied' },
    reason: { type: 'string' },
  },
}

// ── Phase 1: enumerate every requirement (spec: "every requirement is enumerated") ──
phase('Enumerate')
const { requirements } = await agent(
  `Read every ${changeDir}/specs/**/spec.md for change ${changeName}. ` +
  `Enumerate EVERY requirement ('### Requirement:') with its capability folder and scenario names. Miss none.`,
  { label: 'enumerate', phase: 'Enumerate', schema: REQ_LIST }
)
log(`${requirements.length} requirements to verify`)

// ── Phases 2-3: pipeline — each requirement triaged, risky/uncertain ones escalated.
//    pipeline (not barrier): a low-risk req is done while a risky req is still being refuted. ──
const LENSES = ['correctness', 'boundary/exception', 'data-integrity', 'reproducibility', 'cross-track-integration']

const verdicts = await pipeline(
  requirements,
  // stage 1: static triage
  (req) =>
    agent(
      `Statically verify requirement "${req.name}" (capability ${req.capability}) of ${changeName}. ` +
      `Read the spec scenarios and trace to the implementation. Judge met/confidence/risk with file:line evidence. ` +
      `Mark risk=high if it is touched by multiple tracks, security-sensitive, or mutates data.`,
      { label: `triage:${req.name}`, phase: 'Triage', schema: TRIAGE }
    ).then((t) => ({ req, triage: t })),
  // stage 2: escalation routing (spec: low-risk passes on one verdict; uncertain/high-risk escalates)
  async ({ req, triage }) => {
    const escalate = triage.risk === 'high' || triage.confidence === 'low'
    if (!escalate) {
      return { req, status: triage.met ? 'met' : 'unmet', via: 'static', triage }
    }
    // diverse-lens skeptics prompted to REFUTE (spec: "only survivors are marked verified",
    // "cross-track regression is checked") + one dynamic ground-truth test.
    const refutations = await parallel(
      LENSES.map((lens) => () =>
        agent(
          `Through the "${lens}" lens, try to REFUTE the claim that requirement "${req.name}" of ${changeName} is satisfied. ` +
          `Default to refuted=true if you find any failing case. For cross-track-integration, check whether a file satisfying ` +
          `this requirement was later changed by another track and broke it.`,
          { label: `refute:${req.name}:${lens}`, phase: 'Escalate', schema: REFUTE }
        )
      )
    )
    // dynamic ground truth (spec 4.6 / "high-risk requirement is dynamically verified")
    const dyn = await agent(
      `Write and RUN a minimal test exercising a scenario of requirement "${req.name}" of ${changeName}. ` +
      `Report whether it passes. This is ground truth.`,
      { label: `dynamic:${req.name}`, phase: 'Escalate', schema: REFUTE }
    )
    const votes = refutations.filter(Boolean)
    const refutedCount = votes.filter((v) => v.refuted).length + ((dyn && dyn.refuted) ? 1 : 0)
    const total = votes.length + (dyn ? 1 : 0)
    const survived = refutedCount < Math.ceil(total / 2) // verified only on majority survival
    return {
      req,
      status: survived ? 'met' : 'unmet',
      via: 'adversarial',
      triage,
      refutedCount,
      total,
      detail: [...votes, dyn && { ...dyn, lens: 'dynamic' }].filter(Boolean),
    }
  }
)

const results = verdicts.filter(Boolean)

// ── Phase 4: gap + scope checks, then three-way routing ──
phase('Route')
// Completeness + scope (spec: "missing implementation is detected", "out-of-scope behavior is flagged").
const checks = await parallel([
  () =>
    agent(
      `Gap check for ${changeName}: list any requirement in ${changeDir}/specs whose behavior has NO traceable implementation at all ` +
      `(distinct from "implemented incorrectly"). Return a JSON array of requirement names.`,
      { label: 'check:gap', phase: 'Route' }
    ),
  () =>
    agent(
      `Scope-creep check for ${changeName}: list implemented behaviors that map to NO requirement in ${changeDir}/specs. ` +
      `Return a JSON array of short descriptions with file:line.`,
      { label: 'check:scope', phase: 'Route' }
    ),
])

// Classify: a requirement reported unmet is, in spec-driven terms, either a code
// problem (unmet) or a spec problem (defect). Let an agent split them, then route.
const unmet = results.filter((r) => r.status === 'unmet')
await agent(
  `Route verify findings for ${changeName} into three destinations (spec "three-way routing"):\n` +
  `UNMET (code problem) -> append a '- [ ]' task under a new '## Track: verify-reopened (depends: none)' section in ${changeDir}/tasks.md.\n` +
  `SPEC-DEFECT (ambiguous/untestable/contradictory requirement) -> add a note to ${changeDir}/design.md "Open Questions" and DO NOT create an implementation task.\n` +
  `MET -> write/append ${changeDir}/verification-report.md with each met requirement + evidence.\n\n` +
  `For each of these unmet requirements decide unmet-vs-defect:\n${JSON.stringify(unmet.map((r) => ({ name: r.req.name, capability: r.req.capability, evidence: r.triage.evidence })), null, 2)}\n\n` +
  `Also fold the met requirements into verification-report.md, and record gap/scope findings there:\n` +
  `gap=${JSON.stringify(checks[0])}\nscope=${JSON.stringify(checks[1])}`,
  { label: 'route:findings', phase: 'Route' }
)

const confirmedUnmet = unmet.length
return {
  changeName,
  total: results.length,
  met: results.filter((r) => r.status === 'met').length,
  unmet: confirmedUnmet,
  report: `${changeDir}/verification-report.md`,
  // Archive gate consumes this: archive is blocked while pass=false.
  pass: confirmedUnmet === 0,
}
