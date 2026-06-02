## ADDED Requirements

### Requirement: Single-writer multi-reader lease
The orchestrator SHALL maintain, per session, an application-layer lease mapping `sessionId` to a single `writerClientId` and a `leaseExpiry`, granting raw write access to at most one client at a time while allowing any number of readers to observe the stream.

#### Scenario: Only one writer holds the lease
- **WHEN** two clients are connected to the same session and one already holds the write lease
- **THEN** the second client is a reader and is not granted concurrent raw write access
- **AND** both clients continue to receive the read stream

#### Scenario: Lease records writer and expiry
- **WHEN** the lease state for an active session is inspected
- **THEN** it records the current `writerClientId` and a `leaseExpiry` timestamp

### Requirement: Heartbeat renewal and expiry
The lease holder SHALL renew the lease via periodic heartbeats, and the orchestrator SHALL release the lease when its `leaseExpiry` passes without a renewing heartbeat, making the session available to a new writer.

#### Scenario: Heartbeat extends the lease
- **WHEN** the current writer sends a heartbeat before `leaseExpiry`
- **THEN** the orchestrator advances `leaseExpiry` to a later time and the writer retains the lease

#### Scenario: Expired lease without heartbeat is released
- **WHEN** the `leaseExpiry` passes and no renewing heartbeat has been received
- **THEN** the orchestrator releases the lease so another client may acquire it

### Requirement: Auto-release on disconnect
The orchestrator SHALL release a session's write lease immediately when the writer client's connection drops, without waiting for `leaseExpiry`.

#### Scenario: Writer disconnect frees the lease
- **WHEN** the connection of the client holding the write lease drops
- **THEN** the orchestrator releases that session's lease promptly rather than waiting for `leaseExpiry`

### Requirement: Preemptive takeover
A connected reader SHALL be able to preemptively take over the write lease from the current holder, after which the previous holder becomes a reader and loses raw write access.

#### Scenario: Reader takes over from current writer
- **WHEN** a reader requests preemptive takeover of a session that already has a writer
- **THEN** the requesting client becomes the new lease holder
- **AND** the previous holder is demoted to reader and can no longer send raw keystrokes

### Requirement: Keystrokes are lock-gated, approvals are lock-independent
The orchestrator SHALL require the write lease to forward raw keystrokes to the PTY, and SHALL accept structured one-shot approval decisions independently of the write lease.

#### Scenario: Keystroke without the lease is rejected
- **WHEN** a client that does not hold the write lease sends raw keystrokes
- **THEN** the orchestrator does not forward those keystrokes to the PTY

#### Scenario: Approval is accepted without the lease
- **WHEN** a client that does not hold the write lease submits a structured one-shot approval decision
- **THEN** the orchestrator accepts and routes that approval decision regardless of lease ownership
