## ADDED Requirements

### Requirement: Official Codex authorization is a two-stage recoverable flow
The Codex direct-authorize dialog SHALL keep the operator in the existing dialog while a session is preparing and SHALL NOT open an about:blank, placeholder, or external browser tab before the server provides a verification URL and user code. Once the session is awaiting authorization, the dialog SHALL display the server-provided code and URL and provide a distinct user-activated action that opens that exact URL in a new tab with opener and referrer isolation. The dialog SHALL visibly represent preparing, awaiting authorization, finalizing, connected, expired, cancelled, and error outcomes; closing, cancelling, or retrying SHALL target the exact sessionId and late responses SHALL NOT restore a dismissed or superseded UI state.

#### Scenario: Starting login does not open a blank tab
- **WHEN** the operator activates Connect and the server reports preparing
- **THEN** the existing dialog shows preparation progress and no about:blank, placeholder, or OpenAI tab is opened

#### Scenario: Authorization link requires a fresh user action
- **WHEN** the session reaches awaiting_authorization
- **THEN** the dialog shows the returned user code and verification URL and presents an explicit Open OpenAI authorization action
- **AND** activating that action opens the server-provided URL with target=_blank and rel containing noopener and noreferrer

#### Scenario: Closing during preparation cancels the exact attempt
- **WHEN** the operator closes or cancels the dialog while the session is preparing or awaiting authorization
- **THEN** the Web client requests cancellation for that sessionId, stops polling it, and ignores all later responses belonging to it

#### Scenario: Terminal failure is visible and retryable
- **WHEN** the session becomes expired, cancelled, or error
- **THEN** the dialog shows a clear secret-free outcome and offers a retry that creates or recovers only one active attempt

#### Scenario: Connected status remains synchronized
- **WHEN** the session reaches connected
- **THEN** the dialog closes or shows success according to the existing settings interaction and the Codex credential status surfaces refresh to the same connected state

### Requirement: Device-code copying works on supported console origins
The direct-authorize dialog SHALL provide a copy operation whenever a user code is present. It SHALL prefer the asynchronous Clipboard API when available in a secure context, provide a compatibility copy path when that API is unavailable or rejects the operation on a supported HTTP origin, and always report the outcome. If no programmatic copy path succeeds, the dialog SHALL select or focus the visible code and instruct the operator to use the platform copy shortcut. A copy failure SHALL NOT be silently ignored, and the copy control SHALL be unavailable before a code exists.

#### Scenario: Modern clipboard copy succeeds
- **WHEN** a user code is present and the browser permits asynchronous clipboard writing
- **THEN** activating Copy writes the exact code and shows an explicit copied confirmation

#### Scenario: Non-secure HTTP origin uses compatibility copying
- **WHEN** CAP is opened on a supported non-loopback HTTP origin where navigator.clipboard is absent or clipboard writing is denied
- **THEN** activating Copy attempts the compatibility path within the user action and reports success when the code reaches the clipboard

#### Scenario: All programmatic copy paths fail
- **WHEN** neither modern nor compatibility copying succeeds
- **THEN** the visible user code is selected or focused and the dialog tells the operator to press Ctrl+C or Command+C

#### Scenario: Copy is disabled before code issuance
- **WHEN** the login session is idle or preparing and no user code is present
- **THEN** the copy control is disabled or absent and cannot report a false success
