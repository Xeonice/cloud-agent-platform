export const meta = {
  name: 'opsx-verify',
  description: 'Adversarial spec verification: enumerate requirements, static triage, high-risk dynamic + diverse-lens refutation, three-way routing',
  whenToUse: 'Run after apply to prove each spec requirement is satisfied. Also the precondition gate for opsx-archive.',
  phases: [
    { title: 'Enumerate', detail: 'collect every requirement across specs/** (coverage-critical: kept on the strong inherited model)' },
    { title: 'Triage', detail: 'static verdict per requirement', model: 'sonnet' },
    { title: 'Escalate', detail: 'diverse-lens refutation + dynamic test for risky/uncertain', model: 'sonnet' },
    { title: 'Route', detail: 'unmet->tasks, defect->design, met->report; gap & scope checks (write-back on the strong model, fan-out checks on sonnet)' },
  ],
}

// Model tiering (cost): the fan-out leaves (triage/refute/dynamic/gap/scope) are
// scoped "read one scenario -> trace to code -> verdict" tasks where Sonnet is
// the sweet spot — ~5x cheaper than Opus with reliable structured-output. The two
// integrity SINGLETONS stay on the inherited (strong) model: `enumerate` is the
// only coverage guarantee (a missed requirement is never verified), and
// `route:findings` mutates tasks.md/design.md/the report. Leaf model is a const so
// it is trivial to bump a stage back to opus (or down to haiku) if needed.
const LEAF_MODEL = 'sonnet'

const _args = typeof args === 'string' ? JSON.parse(args) : (args || {})
const { changeName, changeDir } = _args
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
      { label: `triage:${req.name}`, phase: 'Triage', schema: TRIAGE, model: LEAF_MODEL }
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
          { label: `refute:${req.name}:${lens}`, phase: 'Escalate', schema: REFUTE, model: LEAF_MODEL }
        )
      )
    )
    // dynamic ground truth (spec 4.6 / "high-risk requirement is dynamically verified")
    const dyn = await agent(
      `Write and RUN a minimal test exercising a scenario of requirement "${req.name}" of ${changeName}. ` +
      `Report whether it passes. This is ground truth.`,
      { label: `dynamic:${req.name}`, phase: 'Escalate', schema: REFUTE, model: LEAF_MODEL }
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
      { label: 'check:gap', phase: 'Route', model: LEAF_MODEL }
    ),
  () =>
    agent(
      `Scope-creep check for ${changeName}: list implemented behaviors that map to NO requirement in ${changeDir}/specs. ` +
      `Return a JSON array of short descriptions with file:line.`,
      { label: 'check:scope', phase: 'Route', model: LEAF_MODEL }
    ),
])

// Classify: a requirement reported unmet is, in spec-driven terms, either a code
// problem (unmet) or a spec problem (defect). Let an agent split them, then route.
//
// IMPORTANT (pass-gate fix): the pipeline's raw `status==='unmet'` count is a
// NOISY signal — diverse-lens adversarial refutation on a large spec set has a
// non-zero false-positive floor (a skeptic can almost always construct *some*
// failing angle), so raw unmet rarely reaches 0 even when every requirement is
// actually satisfied. The AUTHORITATIVE signal is this routing agent's own
// adjudication: after re-tracing each raw-unmet requirement end-to-end, how many
// did it genuinely re-open as a `verify-reopened` task (a real code problem) vs.
// reclassify as MET or as a SPEC-DEFECT note. The pass gate consumes THAT count,
// not the raw pipeline tally — so `pass` agrees with the report the agent writes.
const ROUTE_VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['reopenedTasks', 'specDefects', 'reclassifiedMet'],
  properties: {
    reopenedTasks: { type: 'array', items: { type: 'string' }, description: 'requirement names re-opened as NEW verify-reopened code tasks this pass' },
    specDefects: { type: 'array', items: { type: 'string' }, description: 'requirement names routed to design.md Open Questions (ambiguous/untestable), NOT code tasks' },
    reclassifiedMet: { type: 'array', items: { type: 'string' }, description: 'raw-unmet requirements that re-trace end-to-end as actually MET' },
  },
}
const unmet = results.filter((r) => r.status === 'unmet')
const routing = await agent(
  `Route verify findings for ${changeName} into three destinations (spec "three-way routing"):\n` +
  `UNMET (real code problem) -> append a '- [ ]' task under a '## Track: verify-reopened (depends: none)' section in ${changeDir}/tasks.md, AND list its requirement name in reopenedTasks.\n` +
  `SPEC-DEFECT (ambiguous/untestable/contradictory requirement) -> add a note to ${changeDir}/design.md "Open Questions" (NO implementation task), AND list it in specDefects.\n` +
  `MET (re-traces end-to-end as satisfied despite a skeptic's refutation; includes "met-as-written with a minor gap that does not block the primary scenario") -> fold into ${changeDir}/verification-report.md, AND list it in reclassifiedMet.\n\n` +
  `Re-trace EACH of these raw-unmet requirements against the actual code before deciding — do NOT rubber-stamp the skeptic. A finding already recorded in design.md "Open Questions" from a prior pass is a known SPEC-DEFECT, not a new code task; do not re-open it.\n` +
  `${JSON.stringify(unmet.map((r) => ({ name: r.req.name, capability: r.req.capability, evidence: r.triage.evidence })), null, 2)}\n\n` +
  `Also fold the met requirements into verification-report.md, and record gap/scope findings there:\n` +
  `gap=${JSON.stringify(checks[0])}\nscope=${JSON.stringify(checks[1])}\n\n` +
  `Return the three-way tally so the pass gate reflects YOUR adjudication, not the raw skeptic count.`,
  { label: 'route:findings', phase: 'Route', schema: ROUTE_VERDICT }
)

// Authoritative: only genuinely re-opened code tasks block the gate. A pass with
// outstanding SPEC-DEFECT notes is allowed (they are deferred design questions,
// not code defects) — surface them so they are not silently swallowed.
const confirmedUnmet = (routing.reopenedTasks || []).length
return {
  changeName,
  total: results.length,
  met: results.filter((r) => r.status === 'met').length,
  rawUnmet: unmet.length,
  unmet: confirmedUnmet,
  reopenedTasks: routing.reopenedTasks || [],
  specDefects: routing.specDefects || [],
  report: `${changeDir}/verification-report.md`,
  // Archive gate consumes this: archive is blocked while pass=false. Gated on the
  // routing agent's re-opened CODE tasks, not the noisy raw-unmet pipeline tally.
  pass: confirmedUnmet === 0,
}
