## Why

CAP can run tasks on demand, but recurring automation still requires an external
cron wrapper to call the API. Native scheduled tasks let operators define
recurring headless task runs while preserving the existing task lifecycle,
guardrails, credential attribution, and result delivery behavior.

## What Changes

- Add durable task schedule definitions that store a task creation template,
  owner attribution, recurrence, timezone, enabled state, next fire time, and
  execution policy.
- Add a per-fire run ledger so each scheduled occurrence can be claimed once,
  linked to the `Task` instance it creates, and audited after restarts.
- Add an API-process trigger loop that claims due schedules from Postgres and
  creates `headless-exec` tasks through the same task creation/admission seams
  used by `/v1` and MCP.
- Add REST and `/v1` schedule management/read endpoints with contract schemas
  and OpenAPI coverage.
- Add console schedule management so operators can create, inspect, pause,
  resume, and view recent fires for recurring tasks.
- Preserve existing `TaskStatus` semantics: schedules are not task statuses, and
  each fire creates an ordinary `Task` that is governed by the existing
  guardrails queue.

## Capabilities

### New Capabilities
- `scheduled-tasks`: Durable schedule definitions, schedule-run ledgers, trigger
  execution, missed-fire behavior, overlap policy, and provenance from a
  schedule fire to the created task.

### Modified Capabilities
- `repo-and-task-management`: Task records and task read responses expose
  schedule provenance when a task was created from a schedule, without adding a
  scheduling lifecycle status.
- `public-v1-api`: The versioned API exposes additive schedule CRUD/read
  endpoints and includes them in the generated OpenAPI document.
- `frontend-console`: The authenticated console exposes schedule management and
  links scheduled fires to the ordinary task/session views.

## Impact

- Database:
  - Add schedule and schedule-run tables plus indexes/uniques for due claiming,
    owner lookup, and fire de-duplication.
  - Add nullable schedule provenance on `Task` or a relation from schedule runs
    to tasks.
- API/contracts:
  - Add schedule request/response schemas, list envelopes, validation for cron
    expression/timezone/policies, and `/v1` OpenAPI registration.
  - Add unversioned console endpoints or shared service methods for schedule
    management.
- Runtime:
  - Add a Nest module/service with a process-local poller backed by DB claim
    semantics. No external Redis/queue dependency is introduced.
  - Scheduled fires create programmatic `headless-exec` tasks and reuse
    existing runtime readiness, sandbox environment validation, guardrails,
    delivery, and audit behavior.
- UI:
  - Add schedule creation/edit/list views and show recent runs with links to
    created tasks.
- Tests:
  - Add contract tests, service tests for claim/missed/overlap behavior,
    controller tests for scopes, OpenAPI registration tests, and focused web
    tests for schedule form/list behavior.
