## ADDED Requirements

### Requirement: BoxLite terminal capability requires an image-owned byte bridge

The selected CAP BoxLite image SHALL contain executable
`/usr/local/bin/cap-pty-byte-bridge` and its Python runtime whenever BoxLite advertises
native interactive terminal capability. Runtime preflight SHALL fail before task
admission when that fixed bridge cannot execute. Every terminal open SHALL start the
bridge directly in one native BoxLite TTY execution, inherit the configured workspace
as cwd, and wait for the matching generation/version/mode/initial-geometry `R` frame
before reporting the normalized transport ready.

#### Scenario: WebSocket open alone is not terminal readiness

- **WHEN** the native execution WebSocket opens but the matching bridge `R` frame has
  not arrived
- **THEN** the normalized transport remains connecting and rejects input and resize
- **AND** a bridge timeout, early exit, or outer stderr produces an explicit
  identity-free error rather than a blank ready terminal

#### Scenario: Missing bridge blocks native terminal capability

- **WHEN** runtime preflight cannot execute the fixed image bridge
- **THEN** BoxLite interactive-terminal admission fails with a bridge-specific image
  readiness error
- **AND** CAP does not fall back to raw provider output or another sandbox provider

#### Scenario: Bridge failure cleans only the exact execution

- **WHEN** bridge readiness or framed transport validation fails after BoxLite has
  created an execution
- **THEN** CAP closes that attachment and deletes only its exact native execution
- **AND** cleanup is confirmed by a subsequent exact GET returning not-found

## MODIFIED Requirements

### Requirement: BoxLite terminal output preserves streaming UTF-8

The BoxLite terminal transport SHALL NOT rely on raw child PTY bytes surviving the
server's per-chunk UTF-8 conversion. The image-owned bridge SHALL keep the outer TTY
strictly ASCII and encode bounded child-PTY output chunks as canonical base64 `O`
frames with one generation and continuous sequence numbers. CAP SHALL strictly decode
those frames back to the original ordered bytes and expose those bytes to the
provider-neutral terminal seam. It SHALL use streaming UTF-8 decoding only as a
compatibility text view of the already recovered bytes; it SHALL NOT guess, replace,
or repair bytes lost by the provider.

Input and terminal responses SHALL use bounded canonical-base64 `I` frames, and resize
SHALL use validated ASCII `S` frames. A non-ASCII, malformed, non-canonical, oversized,
stale-generation, duplicate-ready, or discontinuous-sequence frame SHALL fail closed
without emitting guessed output.

#### Scenario: Split child output character is preserved

- **WHEN** a multibyte UTF-8 character is divided at any child-output chunk boundary
  and its ASCII protocol lines are independently fragmented or coalesced by BoxLite
- **THEN** CAP emits the exact original child bytes in order
- **AND** the browser text view contains the original character without replacement
  characters

#### Scenario: Every input byte survives the outer UTF-8 boundary

- **WHEN** CAP sends a payload containing every byte from `0x00` through `0xff`
- **THEN** the bridge decodes one or more canonical `I` frames and writes exactly the
  original bytes to the child PTY in order
- **AND** no input byte is converted through a provider or host UTF-8 string

#### Scenario: Incomplete or invalid output is not repaired

- **WHEN** the bridge stream ends or fails with an incomplete or malformed framed
  payload
- **THEN** CAP fails or closes the transport according to the framed protocol
- **AND** it does not synthesize replacement output or infer the missing original bytes
