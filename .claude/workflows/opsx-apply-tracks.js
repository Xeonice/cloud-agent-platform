export const meta = {
  name: 'opsx-apply-tracks',
  description: 'Track-based parallel OpenSpec apply: correct partition, implement tracks in isolated worktrees, integrate, verify build, repair',
  whenToUse: 'Invoked by the openspec-apply-change skill when a change has at least APPLY_PARALLEL_THRESHOLD pending tasks.',
  phases: [
    { title: 'Correct', detail: 'validate/rebalance draft tracks vs real file coupling' },
    { title: 'Implement', detail: 'parallel tracks, one git worktree each' },
    { title: 'Integrate', detail: 'merge worktrees, resolve shared-file conflicts' },
    { title: 'Verify-build', detail: 'build/test + bounded repair loop' },
    { title: 'Cleanup', detail: 'prune merged isolation worktrees + worktree-* branches' },
  ],
}

// Single source of truth for the serial-vs-parallel cutover (mirrors the
// documented apply_parallel_threshold in openspec/config.yaml; workflow scripts
// cannot import a shared module, so the constant is duplicated by design).
const APPLY_PARALLEL_THRESHOLD = 12
const MAX_REPAIR_ROUNDS = 3

const _args = typeof args === 'string' ? JSON.parse(args) : (args || {})
const { changeName, changeDir, buildCmd } = _args
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
function trackPrompt(t, noIso) {
  return `Implement track "${t.name}" of change ${changeName}. Tasks (in this exact order — spec "intra-track order preserved"): ${t.tasks.join(', ')}.\n` +
    `Read ${changeDir}/tasks.md for task text and the change's specs/design for intent. Make minimal, focused edits. ` +
    `Do NOT touch files outside this track's scope: ${t.files.join(', ')}. ` +
    `Mark each finished task '- [ ]' -> '- [x]' in ${changeDir}/tasks.md.` +
    (noIso ? `\n(Worktree isolation is unavailable — you are editing the MAIN working tree directly, so stay strictly inside this track's files to avoid clobbering sibling tracks.)` : '')
}
// Each wave is a barrier: dependent tracks wait for prerequisites. parallel()
// caps concurrency at 16 automatically, so a wide wave just queues.
const trackFailures = []
for (const wave of waves) {
  const res = await parallel(
    wave.map((t) => () => agent(trackPrompt(t, false), { label: `track:${t.name}`, phase: 'Implement', isolation: 'worktree' }))
  )
  // Graceful degradation: a null result means the track agent failed — most
  // commonly because worktree isolation is unavailable (repo not git-at-session-
  // start, no WorktreeCreate hook). Retry that track SERIALLY without isolation so
  // it still runs; serial execution means no concurrent main-tree conflict.
  for (let i = 0; i < wave.length; i++) {
    if (res[i] != null) continue
    log(`track "${wave[i].name}" failed under worktree isolation; retrying serially without isolation`)
    try {
      await agent(trackPrompt(wave[i], true), { label: `track:${wave[i].name}:noiso`, phase: 'Implement' })
    } catch (e) {
      trackFailures.push(wave[i].name) // genuine failure even without isolation
    }
  }
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

// Ledger reconciliation (fixes the "files created but 0 tasks marked" gap): the
// `[x]` ledger is what idempotent resume depends on, so success must require it
// to be fully consumed — not just a green build.
const LEDGER = {
  type: 'object', additionalProperties: false, required: ['total', 'pending'],
  properties: { total: { type: 'number' }, pending: { type: 'number' }, pendingIds: { type: 'array', items: { type: 'string' } } },
}
const ledger = await agent(
  `Read ${changeDir}/tasks.md and count tasks WITHOUT modifying the file: total tasks, how many are still pending ('- [ ]'), and the pending ids.`,
  { label: 'ledger:count', phase: 'Verify-build', schema: LEDGER }
)

// ── Phase 5: worktree cleanup (finding F) — merged isolation worktrees persist
//    under .claude/worktrees/ with `worktree-*` branches. Their work is already in
//    the main tree (integration phase merged it), so prune them now. Guard: only
//    runs when the ledger is clean and no tracks failed, so we never discard a
//    worktree whose work might not have landed.
phase('Cleanup')
const CLEANUP = {
  type: 'object', additionalProperties: false, required: ['removed'],
  properties: {
    removed: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'string' },
  },
}
let cleanup = { removed: [], skipped: 'not attempted' }
if (trackFailures.length === 0 && ledger.pending === 0) {
  cleanup = await agent(
    `Worktree cleanup for change ${changeName}. The parallel tracks' work is already merged into the main tree.\n` +
    `1. Run \`git worktree list\` and identify isolation worktrees under \`.claude/worktrees/\` (paths containing \`.claude/worktrees/\`). Do NOT touch the main worktree.\n` +
    `2. For each, run \`git worktree remove --force <path>\`.\n` +
    `3. Run \`git worktree prune\`.\n` +
    `4. Delete leftover per-worktree branches matching \`worktree-*\` with \`git branch -D <branch>\`.\n` +
    `Report the removed worktree paths/branches in "removed". Only remove worktrees under .claude/worktrees/ — never the main tree or unrelated worktrees.`,
    { label: 'cleanup:worktrees', phase: 'Cleanup', schema: CLEANUP }
  )
} else {
  cleanup = { removed: [], skipped: 'track failures or pending tasks — worktrees left for inspection' }
  log(`worktree cleanup skipped: ${cleanup.skipped}`)
}

return {
  changeName,
  tracks: plan.tracks.map((t) => t.name),
  waves: waves.length,
  trackFailures,
  buildGreen: green,
  buildSummary: lastSummary,
  pendingTasks: ledger.pending,
  worktreesRemoved: cleanup.removed,
  // HONEST gate: success requires a green build AND no failed tracks AND an empty
  // ledger. A green build alone is NOT success if tracks failed or tasks are still
  // pending (the false-success bug the dry-run exposed).
  success: green && trackFailures.length === 0 && ledger.pending === 0,
}
