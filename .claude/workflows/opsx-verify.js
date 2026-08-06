export const meta = {
  name: 'opsx-verify',
  description: 'Adversarial spec verification: metadata-driven public-surface checks, high-risk dynamic refutation, and archive-blocking three-way routing',
  whenToUse: 'Run after apply to prove each spec requirement is satisfied. Also the precondition gate for opsx-archive.',
  phases: [
    { title: 'Enumerate', detail: 'collect every requirement across specs/** (coverage-critical: kept on the strong inherited model)' },
    { title: 'Triage', detail: 'static verdict plus fail-closed task-metadata routing', model: 'sonnet' },
    { title: 'Escalate', detail: 'real public-surface gate + diverse-lens dynamic refutation', model: 'sonnet' },
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
    evidence: {
      type: 'string',
      description:
        'REQUIRED when refuted is true: the file:line citations or command output that make the ' +
        'refutation checkable by someone who does not trust you. A refutation without this is ' +
        'discarded unread, because it cannot be adjudicated.',
    },
  },
}
// Adjudication replaces the vote. A refutation is a CLAIM, not a ballot: it is checked, not counted.
const ADJUDICATION = {
  type: 'object', additionalProperties: false, required: ['confirmed', 'reasoning'],
  properties: {
    confirmed: { type: 'boolean', description: 'true = the refutation holds against the tree' },
    reasoning: { type: 'string' },
    correction: { type: 'string', description: 'If not confirmed, what the refutation got wrong.' },
  },
}
const PUBLIC_PLAN = {
  type: 'object', additionalProperties: false,
  required: ['changeName', 'phase', 'requirements'],
  properties: {
    changeName: { type: 'string' },
    phase: { type: 'string' },
    requirements: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['requirementId', 'taskIds', 'surfaces', 'dynamicRequired', 'evidenceLanes'],
        properties: {
          requirementId: { type: 'string' },
          taskIds: { type: 'array', items: { type: 'string' } },
          surfaces: { type: 'array', items: { type: 'string' } },
          dynamicRequired: { type: 'boolean' },
          evidenceLanes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}
const EVIDENCE_LANE = {
  type: 'object', additionalProperties: false,
  required: ['passed', 'evidence'],
  properties: {
    passed: { type: 'boolean' },
    evidence: { type: 'string' },
  },
}
const PUBLIC_COMMAND = {
  type: 'object', additionalProperties: false,
  required: ['argv', 'shell', 'ran', 'exitCode'],
  properties: {
    argv: { type: 'array', items: { type: 'string' } },
    shell: { type: 'boolean' },
    ran: { type: 'boolean' },
    exitCode: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  },
}
const PUBLIC_GROUND_TRUTH = {
  type: 'object', additionalProperties: false,
  required: ['verdictVersion', 'changeName', 'phase', 'requirementIds', 'passed', 'command', 'sidecar', 'registry', 'restMetadata', 'mcpSdkMetadata', 'behavior', 'findings'],
  properties: {
    verdictVersion: { type: 'integer' },
    changeName: { type: 'string' },
    phase: { type: 'string' },
    requirementIds: { type: 'array', items: { type: 'string' } },
    passed: { type: 'boolean' },
    command: PUBLIC_COMMAND,
    sidecar: EVIDENCE_LANE,
    registry: EVIDENCE_LANE,
    restMetadata: EVIDENCE_LANE,
    mcpSdkMetadata: EVIDENCE_LANE,
    behavior: EVIDENCE_LANE,
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'route', 'requirementIds', 'reason', 'blocking'],
        properties: {
          kind: { type: 'string' },
          route: { type: 'string', enum: ['unmet', 'spec-defect'] },
          requirementIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          blocking: { type: 'boolean' },
        },
      },
    },
  },
}

function normalizeRequirementName(name) {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ── Phase 1: enumerate every requirement (spec: "every requirement is enumerated") ──
phase('Enumerate')
const { requirements } = await agent(
  `Read every ${changeDir}/specs/**/spec.md for change ${changeName}. ` +
  `Enumerate EVERY requirement ('### Requirement:') with its capability folder and scenario names. Miss none.`,
  { label: 'enumerate', phase: 'Enumerate', schema: REQ_LIST }
)
const quotedChangeName = JSON.stringify(changeName)
// Workflow scripts cannot import repository modules. Delegate only command
// execution to an agent, then consume the repository-owned, machine-readable
// plan. Failure to produce this plan aborts verify instead of silently falling
// back to an LLM risk guess.
const publicPlan = await agent(
  `Run \`node scripts/public-surface-adversarial.mjs plan ${quotedChangeName} --phase verify\` from the repository root. ` +
  `Return its JSON output exactly. Do not infer, add, or remove requirements. If the command fails, fail this step; there is no static fallback.`,
  { label: 'enumerate:public-surface-plan', phase: 'Enumerate', schema: PUBLIC_PLAN }
)
if (publicPlan.changeName !== changeName || publicPlan.phase !== 'verify') {
  throw new Error('opsx-verify received a public-surface plan for the wrong change or phase')
}
const plannedByRequirement = new Map(
  publicPlan.requirements.map((entry) => [entry.requirementId, entry])
)
if (plannedByRequirement.size !== publicPlan.requirements.length) {
  throw new Error('opsx-verify received duplicate requirement ids in the public-surface plan')
}
const routedRequirements = requirements.map((req) => {
  const requirementId = `${req.capability}/${normalizeRequirementName(req.name)}`
  const metadata = plannedByRequirement.get(requirementId)
  return {
    ...req,
    requirementId,
    dynamicRequired: metadata?.dynamicRequired === true,
    taskIds: metadata?.taskIds || [],
    surfaces: metadata?.surfaces || [],
    evidenceLanes: metadata?.evidenceLanes || [],
  }
})
const enumeratedIds = new Set(routedRequirements.map((req) => req.requirementId))
const missingPlannedRequirements = publicPlan.requirements.filter(
  (entry) => !enumeratedIds.has(entry.requirementId)
)
if (missingPlannedRequirements.length > 0) {
  throw new Error(
    `opsx-verify enumeration omitted task requirements: ${missingPlannedRequirements
      .map((entry) => entry.requirementId)
      .join(', ')}`
  )
}
const dynamicRequirements = routedRequirements.filter((req) => req.dynamicRequired)
log(`${requirements.length} requirements to verify; ${dynamicRequirements.length} require public-surface dynamic evidence`)

let publicGroundTruth = null
const publicEvidenceLanes = ['sidecar', 'registry', 'restMetadata', 'mcpSdkMetadata', 'behavior']
if (dynamicRequirements.length > 0) {
  publicGroundTruth = await agent(
    `Run \`node scripts/public-surface-adversarial.mjs verify ${quotedChangeName}\` exactly once from the repository root, without editing any file. ` +
    `The command's focused collectors compare every REST/MCP field set in BOTH directions; registry-declared projection/difference is the only allowance. ` +
    `The command always writes its deterministic JSON verdict to stdout, including when it exits non-zero. Return that stdout JSON EXACTLY; do not infer, summarize, repair, or override any field.`,
    { label: 'dynamic:public-surface-verdict', phase: 'Escalate', schema: PUBLIC_GROUND_TRUTH }
  )

  const expectedRequirementIds = dynamicRequirements
    .map((req) => req.requirementId)
    .sort()
  const verdictRequirementIds = [...publicGroundTruth.requirementIds].sort()
  const expectedArgv = ['pnpm', 'test:public-surface']
  if (
    publicGroundTruth.verdictVersion !== 1 ||
    publicGroundTruth.changeName !== changeName ||
    publicGroundTruth.phase !== 'verify' ||
    JSON.stringify(verdictRequirementIds) !== JSON.stringify(expectedRequirementIds) ||
    JSON.stringify(publicGroundTruth.command.argv) !== JSON.stringify(expectedArgv) ||
    publicGroundTruth.command.shell !== false
  ) {
    throw new Error('opsx-verify rejected an inconsistent deterministic public-surface verdict')
  }
  const lanesPassed = publicEvidenceLanes.every(
    (lane) => publicGroundTruth[lane]?.passed === true
  )
  const blockingFindings = publicGroundTruth.findings.filter((item) => item.blocking)
  const commandStateValid = publicGroundTruth.command.ran
    ? Number.isInteger(publicGroundTruth.command.exitCode) && publicGroundTruth.sidecar.passed
    : publicGroundTruth.command.exitCode === null &&
      !publicGroundTruth.passed &&
      !publicGroundTruth.sidecar.passed
  if (!commandStateValid) {
    throw new Error('opsx-verify rejected an impossible deterministic command state')
  }
  if (
    publicGroundTruth.command.ran &&
    publicGroundTruth.passed !==
      (publicGroundTruth.command.exitCode === 0 &&
        lanesPassed &&
        blockingFindings.length === 0)
  ) {
    throw new Error(
      'opsx-verify rejected a public-surface verdict that contradicts its process exit, evidence lanes, or blocking findings'
    )
  }
  if (publicGroundTruth.passed && (!lanesPassed || blockingFindings.length > 0)) {
    throw new Error('opsx-verify rejected a passing verdict with failed evidence or blocking findings')
  }
  if (!publicGroundTruth.passed && blockingFindings.length === 0) {
    throw new Error('opsx-verify rejected a failing verdict without a blocking finding')
  }
}

function deterministicPublicVerdict(req) {
  const relevantFindings = (publicGroundTruth?.findings || []).filter(
    (item) =>
      item.blocking &&
      (item.requirementIds.length === 0 || item.requirementIds.includes(req.requirementId))
  )
  const lanesPassed = publicEvidenceLanes.every(
    (lane) => publicGroundTruth?.[lane]?.passed === true
  )
  const blocked = !publicGroundTruth?.passed || !lanesPassed || relevantFindings.length > 0
  const first = relevantFindings[0]
  return {
    lens: 'deterministic-public-surface-cli',
    refuted: blocked,
    reason: first?.reason || (blocked
      ? 'The deterministic public-surface command or a mandatory evidence lane failed.'
      : 'The deterministic public-surface command and every mandatory evidence lane passed.'),
    findingType: first?.kind || (blocked ? 'dynamic-evidence-missing' : 'none'),
    route: first?.route || (blocked ? 'unmet' : 'none'),
    archiveBlocked: blocked,
  }
}

// ── Phases 2-3: pipeline — each requirement triaged, risky/uncertain ones escalated.
//    pipeline (not barrier): a low-risk req is done while a risky req is still being refuted. ──
// Two lenses, not five. Across the three verify rounds of extract-runner-minutes-ledger the lens
// bank's net product was one false positive; every genuine defect came from a command. These two
// are kept because they are the ones a command cannot replace: `correctness` reads intent against
// implementation, and `cross-track-integration` is the only check that a file satisfying a
// requirement was later broken by another track. Add a lens back only with a case it caught.
const LENSES = ['correctness', 'cross-track-integration']

// ── R12 deterministic lane ──────────────────────────────────────────────────────────────────
// Measured on extract-runner-minutes-ledger: 8 of 14 requirements and 45 of 74 scenarios were
// decidable by a command, and every real defect the three verify rounds caught was caught by a
// command rather than by a lens. Paying an LLM to re-derive `grep | wc -l` was the largest
// avoidable line item, so a requirement its change proves with assertions never enters the
// adversarial path. Fail-closed by construction: `decidedRequirements` only lists requirements
// whose every assertion passed, and a requirement nobody asserted is simply absent — forgetting
// an assertion costs budget, never a false green.
const ASSERTION_REPORT = {
  type: 'object', additionalProperties: false,
  required: ['present', 'passed', 'decidedRequirements', 'failed'],
  properties: {
    present: { type: 'boolean' },
    passed: { type: 'boolean' },
    decidedRequirements: { type: 'array', items: { type: 'string' } },
    failed: { type: 'array', items: { type: 'string' } },
  },
}
const assertionReport = await agent(
  `Run \`node scripts/spec-assert.mjs ${quotedChangeName} --json\` from the repository root containing ${changeDir}. ` +
  `Return its \`present\`, \`passed\`, \`decidedRequirements\` and \`failed\` fields verbatim. ` +
  `Run that one command and nothing else — do not create, edit, or delete any file, and do not ` +
  `substitute your own judgement for the command's exit status.`,
  { label: 'assertions:run', phase: 'Triage', schema: ASSERTION_REPORT, model: LEAF_MODEL }
)
const assertionDecided = new Set(
  assertionReport?.passed ? (assertionReport.decidedRequirements || []) : []
)
if (assertionReport?.present) {
  log(
    assertionReport.passed
      ? `R12 assertions: green — ${assertionDecided.size} requirement(s) decided without an LLM pass`
      : `R12 assertions: RED (${(assertionReport.failed || []).join(', ')}) — every requirement falls back to the adversarial path`
  )
}

const verdicts = await pipeline(
  routedRequirements,
  // stage 1: static triage — skipped entirely for requirements a green assertion already decided.
  // Public-surface dynamic requirements are NEVER short-circuited: their evidence lanes are the
  // deterministic verdict, and an assertion must not be able to stand in for them.
  (req) =>
    (!req.dynamicRequired && assertionDecided.has(req.requirementId))
      ? Promise.resolve({
          req,
          triage: { met: true, confidence: 'high', risk: 'low', evidence: 'decided by R12 assertions', decidedByAssertions: true },
        })
      : agent(
      `Statically verify requirement "${req.name}" (capability ${req.capability}) of ${changeName}. ` +
      `Read the spec scenarios and trace to the implementation. Judge met/confidence/risk with file:line evidence. ` +
      `Mark risk=high if it is touched by multiple tracks, security-sensitive, or mutates data. ` +
      (req.dynamicRequired
        ? `Task metadata marks ${req.requirementId} as public-surface dynamic; this static verdict is advisory and CANNOT satisfy the requirement.`
        : ''),
      { label: `triage:${req.name}`, phase: 'Triage', schema: TRIAGE, model: LEAF_MODEL }
    ).then((t) => ({ req, triage: t })),
  // stage 2: escalation routing (spec: low-risk passes on one verdict; uncertain/high-risk escalates)
  async ({ req, triage }) => {
    if (triage.decidedByAssertions) {
      return { req, status: 'met', via: 'assertion', triage }
    }
    const escalate = req.dynamicRequired || triage.risk === 'high' || triage.confidence === 'low'
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
          `this requirement was later changed by another track and broke it.\n\n` +
          `If you refute, you MUST fill \`evidence\` with what makes your claim checkable by someone who does not ` +
          `trust you: the file:line you read, or the command and its output. Your refutation is not counted as a ` +
          `vote — it is handed to an independent adjudicator who opens exactly what you cite. A refutation citing ` +
          `nothing is discarded, so vague suspicion costs you the finding.\n` +
          `Watch in particular for a requirement whose claim is about a NAME: an identifier that was renamed rather ` +
          `than removed satisfies every grep written against its old spelling while the thing itself is still there.`,
          { label: `refute:${req.name}:${lens}`, phase: 'Escalate', schema: REFUTE, model: LEAF_MODEL }
        )
      )
    )
    // Public dynamic ground truth is the deterministic CLI verdict. The LLM may
    // still provide skeptic lenses, but it cannot replace or outvote this result.
    const dyn = req.dynamicRequired
      ? deterministicPublicVerdict(req)
      : await agent(
          `RUN a minimal probe exercising a scenario of requirement "${req.name}" of ${changeName}. ` +
          `Report whether it passes. This is ground truth.\n\n` +
          `THE PROBE MUST NOT TOUCH THE TREE IT MEASURES. This is not a tidiness rule — a probe left ` +
          `inside a directory whose file or test count a spec freezes breaks the very requirement it ` +
          `was meant to verify, and that self-inflicted failure has already cost this repository two ` +
          `entire verify rounds. Create nothing inside the repository, in any directory, for any reason. ` +
          `Your options, in order of preference:\n` +
          `  1. run an existing test or gate command and read its exit status;\n` +
          `  2. an inline script — \`node --input-type=module -e '...'\` — which touches no file at all;\n` +
          `  3. a scratch file under the OS temp dir (\`mktemp -d\`), importing from the repo by absolute path;\n` +
          `  4. if and only if the probe genuinely needs a repo-shaped tree, \`git worktree add "$(mktemp -d)" HEAD\`, ` +
          `probe there, then \`git worktree remove --force\` it.\n` +
          `A probe that cannot be written under one of those four is a probe you should not write: report ` +
          `refuted=false with your reasoning instead of manufacturing evidence. ` +
          `Before returning, run \`git status --porcelain\` and confirm you added nothing.`,
          { label: `dynamic:${req.name}`, phase: 'Escalate', schema: REFUTE, model: LEAF_MODEL }
        )
    const votes = refutations.filter(Boolean)
    const refutedCount = votes.filter((v) => v.refuted).length + ((dyn && dyn.refuted) ? 1 : 0)
    const total = votes.length + (dyn ? 1 : 0)

    // ── Adjudication, not majority ────────────────────────────────────────────────────────────
    // A refutation used to be a ballot: `refutedCount < ceil(total/2)`. That treats "I found a
    // defect at this file:line" and "I looked and found nothing" as equal weight, and absence of
    // evidence is not evidence of absence. It cost this repository a shipped defect — a renamed
    // collaborator that made a ratchet count vanish — where one correct, evidence-citing lens was
    // outvoted 1-to-2 by two lenses that found nothing, and the change was reported MET.
    //
    // A refutation is now CHECKED rather than counted. Any refutation that cites evidence is
    // adjudicated by an independent agent against the tree; if the adjudicator confirms it, the
    // requirement is unmet no matter how many lenses found nothing. This also protects the other
    // direction, which a "any refutation blocks" rule would not: a wrong refutation is discarded by
    // the adjudicator instead of blocking the archive.
    const claims = votes.filter((v) => v.refuted)
    let adjudications = []
    if (claims.length > 0) {
      adjudications = await parallel(
        claims.map((claim, index) => () =>
          agent(
            `Adjudicate a refutation of requirement "${req.name}" (${req.requirementId}) of ${changeName}.\n\n` +
            `You are not a third opinion and you are not voting. Check THIS SPECIFIC CLAIM against the ` +
            `tree and report whether it holds.\n\n` +
            `LENS: ${claim.lens}\nCLAIM: ${claim.reason}\nEVIDENCE OFFERED: ${claim.evidence || '(none — the lens cited nothing)'}\n\n` +
            `Open every file:line the claim cites and read it. Re-run any command it quotes. Confirm ` +
            `only what you have seen for yourself. If the claim cites nothing checkable, report ` +
            `confirmed=false and say the lens gave you nothing to check. If the claim is right about a ` +
            `defect but wrong about a detail, it is still CONFIRMED — say what the detail should be in ` +
            `\`correction\`. If the tree does not show what the claim says it shows, report ` +
            `confirmed=false with what you actually found.`,
            { label: `adjudicate:${req.name}:${index}`, phase: 'Escalate', schema: ADJUDICATION, model: LEAF_MODEL }
          )
        )
      )
    }
    const confirmedRefutations = adjudications.filter((a) => a && a.confirmed).length

    // Public requirements stay fail-closed on their mandatory dynamic evidence: the deterministic
    // verdict cannot be talked out of by any lens or adjudicator.
    const survived = req.dynamicRequired
      ? Boolean(dyn) && !dyn.refuted && !dyn.archiveBlocked
      : confirmedRefutations === 0 && !(dyn && dyn.refuted)
    return {
      req,
      status: survived ? 'met' : 'unmet',
      via: 'adversarial',
      triage,
      refutedCount,
      total,
      confirmedRefutations,
      adjudications: adjudications.filter(Boolean),
      dynamic: dyn,
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
// IMPORTANT: the pipeline's raw `status==='unmet'` count is a
// NOISY signal — diverse-lens adversarial refutation on a large spec set has a
// non-zero false-positive floor (a skeptic can almost always construct *some*
// failing angle), so raw unmet rarely reaches 0 even when every requirement is
// actually satisfied. The AUTHORITATIVE signal is this routing agent's own
// adjudication: after re-tracing each raw-unmet requirement end-to-end, how many
// did it genuinely re-open as a `verify-reopened` task (a real code problem) vs.
// reclassify as MET or as a SPEC-DEFECT note. Public-surface dynamic findings are
// the exception: unmet and blocking spec-defect evidence is machine-routed and
// cannot be reclassified away by the final prose adjudicator.
const mandatoryDynamicFindings = []
if (dynamicRequirements.length > 0) {
  const lanesPassed = Boolean(publicGroundTruth) && publicEvidenceLanes.every(
    (lane) => publicGroundTruth[lane]?.passed === true
  )
  const reportedFindings = (publicGroundTruth?.findings || []).filter(
    (item) => item.blocking
  )
  mandatoryDynamicFindings.push(...reportedFindings)
  if ((!publicGroundTruth?.passed || !lanesPassed) && reportedFindings.length === 0) {
    mandatoryDynamicFindings.push({
      kind: 'dynamic-evidence-missing',
      route: 'unmet',
      requirementIds: dynamicRequirements.map((req) => req.requirementId),
      reason: 'The shared public-surface gate or a mandatory evidence lane failed.',
      blocking: true,
    })
  }
}
const uniqueDynamicFindings = [
  ...new Map(
    mandatoryDynamicFindings.map((item) => [
      `${item.kind}\u0000${item.route}\u0000${(item.requirementIds || []).join(',')}\u0000${item.reason}`,
      item,
    ])
  ).values(),
]
const ROUTE_VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['reopenedTasks', 'specDefects', 'blockingSpecDefects', 'reclassifiedMet'],
  properties: {
    reopenedTasks: { type: 'array', items: { type: 'string' }, description: 'stable capability/slug ids re-opened as NEW verify-reopened code tasks this pass' },
    specDefects: { type: 'array', items: { type: 'string' }, description: 'stable capability/slug ids routed to design.md Open Questions (ambiguous/untestable), NOT code tasks' },
    blockingSpecDefects: { type: 'array', items: { type: 'string' }, description: 'stable capability/slug ids for public impact/exclusion defects that keep archive gated until corrected' },
    reclassifiedMet: { type: 'array', items: { type: 'string' }, description: 'stable capability/slug ids that re-trace end-to-end as actually MET' },
  },
}
const unmet = results.filter((r) => r.status === 'unmet')
const routing = await agent(
  `Route verify findings for ${changeName} into three destinations (spec "three-way routing"):\n` +
  `UNMET (real code problem) -> append a '- [ ]' task under a '## Track: verify-reopened (depends: none)' section in ${changeDir}/tasks.md, AND list its stable capability/slug requirement id in reopenedTasks.\n` +
  `SPEC-DEFECT (ambiguous/untestable/contradictory requirement) -> add a note to ${changeDir}/design.md "Open Questions" (NO implementation task), AND list its stable id in specDefects. Undeclared public impact and false protocol exclusions MUST also be listed by stable id in blockingSpecDefects because archive cannot accept a false sidecar claim.\n` +
  `MET (re-traces end-to-end as satisfied despite a skeptic's refutation; includes "met-as-written with a minor gap that does not block the primary scenario") -> fold into ${changeDir}/verification-report.md, AND list its stable id in reclassifiedMet.\n\n` +
  `Re-trace EACH raw-unmet requirement against the actual code before deciding — do NOT rubber-stamp the skeptic. However, do NOT reclassify or drop the machine-routed public findings below; route them to reopenedTasks or blockingSpecDefects according to their route.\n` +
  `${JSON.stringify(unmet.map((r) => ({ id: r.req.requirementId, name: r.req.name, capability: r.req.capability, evidence: r.triage.evidence, dynamic: r.dynamic })), null, 2)}\n\n` +
  `Mandatory public findings=${JSON.stringify(uniqueDynamicFindings)}\n\n` +
  `Also fold the met requirements into verification-report.md, and record gap/scope findings there:\n` +
  `gap=${JSON.stringify(checks[0])}\nscope=${JSON.stringify(checks[1])}\n\n` +
  `Return the three-way tally so the pass gate reflects YOUR adjudication, not the raw skeptic count.`,
  { label: 'route:findings', phase: 'Route', schema: ROUTE_VERDICT }
)

// Generic skeptic findings still rely on the strong routing adjudicator. Public
// dynamic findings do not: both unmet and blocking spec defects independently
// keep archive closed, even if the routing agent omits or reclassifies one.
const dynamicUnmet = uniqueDynamicFindings.filter((item) => item.route === 'unmet')
const dynamicSpecDefects = uniqueDynamicFindings.filter((item) => item.route === 'spec-defect')
const confirmedUnmet = new Set([
  ...(routing.reopenedTasks || []),
  ...dynamicUnmet.flatMap((item) =>
    item.requirementIds?.length ? item.requirementIds : [item.kind]
  ),
]).size
const blockingSpecDefects = new Set([
  ...(routing.blockingSpecDefects || []),
  ...dynamicSpecDefects.flatMap((item) =>
    item.requirementIds?.length ? item.requirementIds : [item.kind]
  ),
])
const archiveBlockers = [
  ...(routing.reopenedTasks || []).map((requirement) => ({ route: 'unmet', requirement })),
  ...(routing.blockingSpecDefects || []).map((requirement) => ({ route: 'spec-defect', requirement })),
  ...uniqueDynamicFindings,
]
return {
  changeName,
  total: results.length,
  met: results.filter((r) => r.status === 'met').length,
  rawUnmet: unmet.length,
  unmet: confirmedUnmet,
  reopenedTasks: routing.reopenedTasks || [],
  specDefects: routing.specDefects || [],
  blockingSpecDefects: [...blockingSpecDefects],
  dynamicFindings: uniqueDynamicFindings,
  archiveBlockers,
  report: `${changeDir}/verification-report.md`,
  // Archive gate consumes this: public unmet and blocking impact/spec defects
  // are both terminal blockers. Missing dynamic evidence fails closed above.
  pass: confirmedUnmet === 0 && blockingSpecDefects.size === 0,
}
