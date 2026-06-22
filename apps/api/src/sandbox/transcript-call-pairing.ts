/**
 * The cross-runtime call-pairing primitive (unify-transcript-parsers, Track 2 /
 * design D5). Both render parsers emit a tool turn when they see a tool CALL and
 * must attach the matching tool OUTPUT that arrives on a LATER line, linked by an
 * id field — codex pairs `function_call` ↔ `function_call_output` by `call_id`;
 * claude pairs a `tool_use` block ↔ a `tool_result` block by `tool_use_id`. The
 * mechanism is identical; only the id field name differs, so it lives here once,
 * parameterized by that name, and each parser reuses it.
 *
 * Contract (matches the codex parser's existing `toolByCallId` semantics verbatim):
 *   - `registerCall(id, turn)` buffers a call turn by its id. The turn is created
 *     with `output: null` by its owner; pairing only mutates `output` later.
 *   - `attachOutput(id, output)` finds the buffered call and sets its `output`.
 *     An UNMATCHED call (no output ever arrives) keeps its `output: null`. An
 *     ORPHAN output (no buffered call for that id) is silently ignored — it never
 *     throws, because a best-effort read of a frozen sandbox must yield "what was
 *     parseable".
 *
 * Generic over the turn type `T` so each parser pairs its own concrete tool-turn
 * shape; the helper only requires that `T` carry a writable `output`.
 */

/** The minimal turn shape the pairing helper writes back into. */
export interface PairableTurn {
  output: string | null;
}

/**
 * A buffer that pairs tool-call turns with their later outputs by an id field.
 *
 * @typeParam T the concrete tool-turn type being paired (must carry `output`).
 */
export class CallPairing<T extends PairableTurn> {
  /** Buffered call turns indexed by their id, awaiting a matching output. */
  private readonly byId = new Map<string, T>();

  /**
   * Buffer a tool-call turn under its id so a later output can attach to it.
   * A non-string id is ignored (the turn is already emitted with `output: null`).
   */
  registerCall(id: unknown, turn: T): void {
    if (typeof id === 'string') this.byId.set(id, turn);
  }

  /**
   * Attach `output` to the buffered call with this id. Returns the paired turn
   * (so a caller may chain), or `undefined` for an orphan output / non-string id —
   * never throwing in either case.
   */
  attachOutput(id: unknown, output: string): T | undefined {
    const turn = typeof id === 'string' ? this.byId.get(id) : undefined;
    if (turn) turn.output = output;
    return turn;
  }
}
