# frontend-console Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Maintained component library package
`packages/ui` SHALL provide a shadcn/ui + Tailwind CSS based component library consumed by `apps/web` via `workspace:*`, and SHALL include a reusable `<Terminal>` component wrapping xterm.js with the fit, serialize, and unicode11 addons configured. `apps/web` SHALL NOT inline its own copy of these shared components.

#### Scenario: Web app consumes shared components
- **WHEN** `apps/web` renders a button, card, or the terminal surface
- **THEN** it imports them from `packages/ui` rather than redefining them locally

#### Scenario: Terminal component wraps xterm with required addons
- **WHEN** the `<Terminal>` component mounts
- **THEN** it instantiates an xterm.js terminal with the fit, serialize, and unicode11 addons loaded

### Requirement: Session page renders the live terminal and controls
The `/tasks/[id]` page SHALL mount the `<Terminal>` component, connect to the task's authenticated WebSocket, render the raw byte stream as the live terminal, display the current task status, and provide a keystroke/command input plus an approval surface for pending `PermissionRequest` decisions.

#### Scenario: Session page streams the live terminal
- **WHEN** the operator opens `/tasks/[id]` for a running task
- **THEN** the page connects the WebSocket and renders the task's live terminal byte stream in the `<Terminal>` component

#### Scenario: Pending approval surfaces on the session page
- **WHEN** a `PermissionRequest` is pending for the open task
- **THEN** the page shows an approval surface offering allow/deny, and submitting a decision resolves it independently of the write lock

### Requirement: Dashboard lists tasks as a fleet
The `/` dashboard SHALL list tasks with their status and provide an action to enter a task's session. It SHALL reflect at least the running/queued/awaiting-input states.

#### Scenario: Dashboard shows tasks and links to sessions
- **WHEN** the operator opens `/`
- **THEN** the page lists existing tasks with their status and each offers an action navigating to its `/tasks/[id]` session

### Requirement: New task creation from the console
The console SHALL provide a form (page or modal) to create a task by selecting a registered repo and branch and entering a prompt/strategy, submitting via the authenticated REST API; on success it SHALL surface the created task and a path into its session.

#### Scenario: Operator creates a task
- **WHEN** the operator submits the new-task form with a repo, branch, and prompt
- **THEN** the console POSTs to the tasks REST API and, on success, surfaces the created task with a link into its session

### Requirement: Configurable cross-origin API and WebSocket endpoints
`apps/web` SHALL read the API base URL and WebSocket URL from environment configuration (`API_BASE_URL` / `WS_URL`) and SHALL NOT assume the api is same-origin, so the Vercel web-only deploy can target a Fly/compose api origin.

#### Scenario: Web targets a cross-origin api
- **WHEN** `API_BASE_URL`/`WS_URL` point at a different origin than the web app
- **THEN** the console issues its REST and WebSocket calls to that configured origin rather than its own
