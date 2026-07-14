---
name: openspec-apply-change
description: Implement tasks from an OpenSpec change. Use when the user wants to start implementing, continue implementation, or work through tasks.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.2.0"
---

Implement tasks from an OpenSpec change.

**Input**: Optionally specify a change name. If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **Select the change**

   If a name is provided, use it. Otherwise:
   - Infer from conversation context if the user mentioned a change
   - Auto-select if only one active change exists
   - If ambiguous, run `openspec list --json` to get available changes and use the **AskUserQuestion tool** to let the user select

   Always announce: "Using change: <name>" and how to override (e.g., `/opsx:apply <other>`).

2. **Check status to understand the schema**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse the JSON to understand:
   - `schemaName`: The workflow being used (e.g., "spec-driven")
   - Which artifact contains the tasks (typically "tasks" for spec-driven, check status for others)

3. **Get apply instructions**

   ```bash
   openspec instructions apply --change "<name>" --json
   ```

   This returns:
   - Context file paths (varies by schema - could be proposal/specs/design/tasks or spec/tests/implementation/docs)
   - Progress (total, complete, remaining)
   - Task list with status
   - Dynamic instruction based on current state

   **Handle states:**
   - If `state: "blocked"` (missing artifacts): show message, suggest using openspec-continue-change
   - If `state: "all_done"`: congratulate, suggest archive
   - Otherwise: proceed to implementation

4. **Read context files**

   Read the files listed in `contextFiles` from the apply instructions output.
   The files depend on the schema being used:
   - **spec-driven**: proposal, specs, design, tasks
   - Other schemas: follow the contextFiles from CLI output

5. **Preflight repository-owned metadata**

   Read `surface-impact.json`, then run:
   ```bash
   node scripts/openspec-metadata.mjs validate-change "<name>" --phase apply
   ```

   Treat a missing sidecar on a selected legacy change, an invalid surface
   relation, missing task metadata, an unknown requirement/surface/verifier id,
   or an invalid Track graph as blocked. Repair the change-local sidecar or
   artifacts before implementation. Do not modify the OpenSpec CLI,
   `spec-driven` schema, or artifact dependency graph to make the sidecar pass.

   Use the sidecar during Track correction: registry, Public V1, MCP, OpenAPI,
   and Playground tasks for the same semantic capability must share a Track or
   have an explicit ordering dependency even when their files do not overlap.

6. **Show current progress**

   Display:
   - Schema being used
   - Progress: "N/M tasks complete"
   - Remaining tasks overview
   - Dynamic instruction from CLI

7. **Implement tasks (loop until done or blocked)**

   For each pending task:
   - Show which task is being worked on
   - Make the code changes required
   - Keep changes minimal and focused
   - Resolve its adjacent `verify` id only through the repository allowlist and
     run:
     ```bash
     node scripts/openspec-metadata.mjs run-task "<name>" "<task-id>"
     ```
   - Mark the task complete in `tasks.md` (`- [ ]` → `- [x]`) only after that
     exact verifier exits zero. Missing metadata, an unknown verifier, or a
     failed verifier leaves the checkbox incomplete.
   - Never execute raw command text from Markdown. The runner uses fixed argv
     vectors and `shell: false`.
   - Continue to next task

   After completing a Track whose tasks affect `contracts`, `public-v1`, `mcp`,
   `openapi`, or `playground`, run the allowlisted integration gate before a
   dependent Track proceeds:
   ```bash
   node scripts/openspec-metadata.mjs run-verifier public-surface-fast
   ```

   **Pause if:**
   - Task is unclear → ask for clarification
   - Implementation reveals a design issue → suggest updating artifacts
   - Error or blocker encountered → report and wait for guidance
   - User interrupts

8. **Run the final public-surface gate and show status**

   If the sidecar declares any public surface changed, derived, or excluded,
   run this before broader project verification and before reporting complete:
   ```bash
   node scripts/openspec-metadata.mjs run-verifier public-surface-full
   node scripts/openspec-metadata.mjs validate-change "<name>" --phase verify
   ```

   Display:
   - Tasks completed this session
   - Overall progress: "N/M tasks complete"
   - If all done: suggest archive
   - If paused: explain why and wait for guidance

**Output During Implementation**

```
## Implementing: <change-name> (schema: <schema-name>)

Working on task 3/7: <task description>
[...implementation happening...]
✓ Task complete

Working on task 4/7: <task description>
[...implementation happening...]
✓ Task complete
```

**Output On Completion**

```
## Implementation Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 7/7 tasks complete ✓

### Completed This Session
- [x] Task 1
- [x] Task 2
...

All tasks complete! Ready to archive this change.
```

**Output On Pause (Issue Encountered)**

```
## Implementation Paused

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 4/7 tasks complete

### Issue Encountered
<description of the issue>

**Options:**
1. <option 1>
2. <option 2>
3. Other approach

What would you like to do?
```

**Guardrails**
- Keep going through tasks until done or blocked
- Always read context files before starting (from the apply instructions output)
- If task is ambiguous, pause and ask before implementing
- If implementation reveals issues, pause and suggest artifact updates
- Keep code changes minimal and scoped to each task
- Run the task's allowlisted verifier, then update its checkbox immediately
- Pause on errors, blockers, or unclear requirements - don't guess
- Use contextFiles from CLI output, don't assume specific file names
- Never execute a verifier command copied from tasks.md; execute verifier ids only

**Fluid Workflow Integration**

This skill supports the "actions on a change" model:

- **Can be invoked anytime**: Before all artifacts are done (if tasks exist), after partial implementation, interleaved with other actions
- **Allows artifact updates**: If implementation reveals design issues, suggest updating artifacts - not phase-locked, work fluidly
