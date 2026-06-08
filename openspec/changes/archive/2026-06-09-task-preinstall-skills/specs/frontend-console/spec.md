## MODIFIED Requirements

### Requirement: New task creation from the console
The console SHALL provide BOTH a modal (on `/dashboard`) and a full-page form (`/tasks/new`) to create a task, sharing the same form, live command preview, and submit logic. The form SHALL select a registered repo (options from `GET /repos`, restricted to imported repos as the security scope), a branch, an execution strategy, an OPTIONAL multi-select of SKILLS to preinstall (e.g. OpenSpec, BMAD — options from a static catalog matching the server-side skill allowlist), and a prompt/description (with a live client-side word count), default the "破坏性写入前停止" checkbox to checked, and render a side preflight (3 ReviewStep cards complete/warn) plus a live `agentctl` `CommandPreview` derived from form state (including the selected skills). Submission SHALL POST to `POST /repos/:repoId/tasks` via a `createTaskMutation`, sending the selected skill ids in the create body's `skills` field; on success it SHALL surface the created run id and a deep link into `/tasks/$taskId`, persist `selectedRepo`/`branch`/`latestRunId` to local store, invalidate the tasks query, and emit a Sonner toast. The console SHALL render branch and strategy controls even though the current backend does not read these fields back (branch/strategy persistence is specified in `repo-and-task-management`); the page SHALL NOT misrepresent unsent/unread fields as confirmed task state. The skill picker's selection SHALL be submitted as `skills` and reflected in the command preview; an empty selection preserves the no-preinstall behavior.

#### Scenario: Operator creates a task from the dashboard modal
- **WHEN** the operator submits the new-task modal with a repo, branch, strategy, and prompt
- **THEN** the console POSTs to `POST /repos/:repoId/tasks` and, on success, surfaces the created run id with a link into its `/tasks/$taskId` session and invalidates the task list

#### Scenario: Full-page create mirrors the modal
- **WHEN** the operator opens `/tasks/new` and submits the form
- **THEN** it uses the same shared form, command preview, and `createTaskMutation` as the dashboard modal and produces an identical create result with a session deep link

#### Scenario: Operator selects skills to preinstall
- **WHEN** the operator selects one or more skills (e.g. OpenSpec) in the create form and submits
- **THEN** the create body includes the selected skill ids in its `skills` field, and the command preview reflects the selected skills
- **AND** an empty skill selection submits no `skills` (or an empty list) and preserves the prior no-preinstall behavior

#### Scenario: Skill options come from the allowlisted catalog
- **WHEN** the skill multi-select is populated
- **THEN** its options come from a static catalog matching the server-side skill allowlist, so the operator cannot select a skill the orchestrator would not execute

#### Scenario: Command preview reacts to form state
- **WHEN** the operator edits any field of the create form (including the skill selection)
- **THEN** the `CommandPreview` recomputes the `agentctl` command from form state and the word count updates, both as `useMemo`-derived values not stored in the query cache

#### Scenario: Repo options are scoped to imported repos
- **WHEN** the repo select is populated
- **THEN** its options come from `GET /repos` (the imported set) and no repo outside the imported scope is selectable
