## ADDED Requirements

### Requirement: BoxLite terminal output preserves streaming UTF-8
The BoxLite terminal transport SHALL decode stdout and stderr as streaming UTF-8 rather than decoding each WebSocket frame independently. It SHALL preserve multibyte code points split across provider frame boundaries before emitting output into CAP's provider-neutral terminal gateway.

#### Scenario: Split stdout character is preserved
- **WHEN** BoxLite sends stdout bytes for a multibyte UTF-8 character split across two WebSocket frames
- **THEN** CAP emits the original character in terminal output
- **AND** the browser terminal does not receive replacement characters for that split sequence

#### Scenario: Split stderr character is preserved independently
- **WHEN** BoxLite sends stderr bytes for a multibyte UTF-8 character split across two WebSocket frames
- **THEN** CAP emits the original character in terminal output without mixing stdout and stderr decoder state

#### Scenario: Decoder state is flushed on terminal close
- **WHEN** the BoxLite terminal stream exits or closes with buffered decoder state
- **THEN** the transport flushes any complete buffered text before closing the CAP terminal stream
