export const meta = {
  name: 'opsx-apply-tracks',
  description: 'Track-based parallel OpenSpec apply: correct partition, implement tracks in isolated worktrees, integrate, verify build, repair',
  whenToUse: 'Invoked by the openspec-apply-change skill when a change has at least APPLY_PARALLEL_THRESHOLD pending tasks.',
  phases: [
    { title: 'Correct', detail: 'validate/rebalance draft tracks vs real file coupling' },
    { title: 'Implement', detail: 'parallel tracks, one git worktree each' },
    { title: 'Integrate', detail: 'merge worktrees, resolve shared-file conflicts' },
    { title: 'Verify-build', detail: 'build/test + bounded repair loop' },
  ],
}

// Single source of truth for the serial-vs-parallel cutover (mirrors the
// documented apply_parallel_threshold in openspec/config.yaml; workflow scripts
// cannot import a shared module, so the constant is duplicated by design).
const APPLY_PARALLEL_THRESHOLD = 12
const MAX_REPAIR_ROUNDS = 3

const { changeName, changeDir, buildCmd } = args || {}
if (!changeName || !changeDir) {
  throw new Error('opsx-apply-tracks requires args { changeName, changeDir, buildCmd? }')
}

const TRACKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tracks', 'integrationTrack'],
  properties: {
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'depends', 'tasks', 'files'],
        properties: {
          name: { type: 'string' },
          depends: { type: 'array', items: { type: 'string' } },
          tasks: { type: 'array', items: { type: 'string' }, description: 'pending task ids only (e.g. "3.2")' },
          files: { type: 'array', items: { type: 'string' }, description: 'files this track expects to touch' },
        },
      },
    },
    integrationTrack: {
      type: 'object',
      additionalProperties: false,
      required: ['tasks', 'sharedFiles'],
      properties: {
        tasks: { type: 'array', items: { type: 'string' } },
        sharedFiles: { type: 'array', items: { type: 'string' }, description: 'files written by >1 draft track' },
      },
    },
  },
}

// ── Phase 1: correction (spec: "draft tracks are corrected against real coupling",
//                          "shared-file tasks are isolated", idempotent resume) ──
phase('Correct')
const plan = await agent(
  `Read ${changeDir}/tasks.md and the change's design.md/specs.\n` +
  `1. Consider ONLY pending tasks ('- [ ]'); ignore '- [x]' (idempotent resume — spec "completed tasks are not re-run").\n` +
  `2. Take the draft '## N. Track: <name> (depends: ...)' partition as a hypothesis.\n` +
  `3. Scan the codebase to find which files each task will actually touch.\n` +
  `4. Any file touched by tasks in >1 track is a shared file: pull those tasks into the integrationTrack (run serially after parallel tracks) — spec "shared-file tasks are isolated".\n` +
  `5. Rebalance oversized/undersized tracks so independent tracks touch disjoint files.\n` +
  `6. WRITE the corrected partition back into ${changeDir}/tasks.md headers, then return it.`,
  { label: 'correct:partition', phase: 'Correct', schema: TRACKS_SCHEMA }
)

// Topological waves over track depends — independent tracks share a wave.
function toWaves(tracks) {
  const byName = new Map(tracks.map((t) => [t.name, t]))
  const done = new Set()
  const waves = []
  let guard = 0
  while (done.size < tracks.length && guard++ < tracks.length + 2) {
    const wave = tracks.filter(
      (t) => !done.has(t.name) && t.depends.every((d) => done.has(d) || !byName.has(d))
    )
    if (!wave.length) { // dependency cycle or dangling dep — run the rest in one wave rather than stall
      waves.push(tracks.filter((t) => !done.has(t.name)))
      break
    }
    wave.forEach((t) => done.add(t.name))
    waves.push(wave)
  }
  return waves
}
const waves = toWaves(plan.tracks)
log(`${plan.tracks.length} tracks in ${waves.length} dependency waves; ${plan.integrationTrack.tasks.length} shared-file tasks serialized`)

// ── Phase 2: parallel implementation, worktree-isolated (spec: "tracks run in
//             isolated worktrees", "intra-track order preserved") ──
phase('Implement')
function implementTrack(t) {
  return agent(
    `Implement track "${t.name}" of change ${changeName}. Tasks (in this exact order — spec "intra-track order preserved"): ${t.tasks.join(', ')}.\n` +
    `Read ${changeDir}/tasks.md for task text and the change's specs/design for intent. Make minimal, focused edits. ` +
    `Do NOT touch files outside this track's scope: ${t.files.join(', ')}. ` +
    `Mark each finished task '- [ ]' -> '- [x]' in ${changeDir}/tasks.md.`,
    { label: `track:${t.name}`, phase: 'Implement', isolation: 'worktree' }
  )
}
// Each wave is a barrier: dependent tracks wait for prerequisites. parallel()
// caps concurrency at 16 automatically, so a wide wave just queues.
for (const wave of waves) {
  await parallel(wave.map((t) => () => implementTrack(t)))
}

// ── Phase 3: integration — merge worktrees + shared-file tasks serially ──
phase('Integrate')
await agent(
  `All parallel tracks for ${changeName} are merged into the working tree. Now:\n` +
  `1. Resolve any shared-file conflicts coherently.\n` +
  `2. Implement the serialized integration tasks: ${plan.integrationTrack.tasks.join(', ') || '(none)'} ` +
  `which touch shared files: ${plan.integrationTrack.sharedFiles.join(', ') || '(none)'}.\n` +
  `Mark them '- [x]' in ${changeDir}/tasks.md when done.`,
  { label: 'integrate:merge', phase: 'Integrate' }
)

// ── Phase 4: build verification + bounded repair (spec: "build is verified after
//             merge" — never report success on red build; "failures trigger repair loop") ──
phase('Verify-build')
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['green', 'summary'],
  properties: { green: { type: 'boolean' }, summary: { type: 'string' }, failures: { type: 'array', items: { type: 'string' } } },
}
const buildInstruction = buildCmd
  ? `Run \`${buildCmd}\``
  : `Discover the project's build/test command (package.json scripts, Makefile, etc.) and run it`
let green = false
let lastSummary = ''
for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
  const v = await agent(
    `${buildInstruction} for change ${changeName}. Report green=true only if build AND tests pass. List concrete failures.`,
    { label: `build:check:${round}`, phase: 'Verify-build', schema: VERDICT }
  )
  lastSummary = v.summary
  if (v.green) { green = true; break }
  if (round === MAX_REPAIR_ROUNDS) break // budget exhausted — do NOT claim success
  log(`build red (round ${round}); dispatching repair`)
  await agent(
    `The build/tests are failing for ${changeName}. Fix these failures with minimal edits:\n${(v.failures || []).join('\n')}\n` +
    `Stay within the change's scope; do not introduce behavior absent from the specs.`,
    { label: `build:repair:${round}`, phase: 'Verify-build' }
  )
}

return {
  changeName,
  tracks: plan.tracks.map((t) => t.name),
  waves: waves.length,
  buildGreen: green,
  buildSummary: lastSummary,
  // Honest signal: success is false on a red build (spec "never report success on red build").
  success: green,
}
