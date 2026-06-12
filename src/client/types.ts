/** Public TypeScript surface for the idempotency client. */

/**
 * Validates and narrows an opaque stored `result` to the host's `TResult` at the
 * client boundary. Receives the raw value the component replayed (`unknown`) and
 * MUST return a typed `TResult` or throw. A `convex/values` validator's `.parse`
 * (or a Zod `.parse`) fits directly; omit it to keep results unvalidated.
 *
 * @typeParam TResult - The host's stored outcome type.
 */
export type ResultParser<TResult> = (value: unknown) => TResult;

/** Outcome of {@link Idempotency.begin} for a key. */
export type BeginResult<TResult> =
  | {
      /** The key was just minted; do the work, then call `complete`. */
      state: "fresh";
    }
  | {
      /** Another attempt holds the key; do not re-run. */
      state: "inflight";
      /** Absolute ms timestamp when the inflight lease frees. */
      expiresAt: number;
      /** How long to back off (ms) before retrying — the crashed-worker self-heal window. */
      retryAfterMs: number;
    }
  | {
      /** A prior attempt already completed; `result` holds its outcome. */
      state: "done";
      /** The recorded outcome (absent if completed without one). */
      result?: TResult;
    };

/** Outcome of {@link Idempotency.complete} — discriminated so a lost claim is detectable. */
export type CompleteResult =
  | {
      /** The outcome was written to the ledger. */
      recorded: true;
    }
  | {
      /** The claim was lost; the work ran but its ledger row was gone. */
      recorded: false;
      /**
       * `missing` — no key for this id/scope. `expired` — the inflight lease
       * lapsed before completion. `already_done` — a prior attempt won the race.
       */
      reason: "missing" | "expired" | "already_done";
    };

/** Construction options for the {@link Idempotency} client. */
export interface IdempotencyOptions<TResult> {
  /** Namespace applied when a call omits `scope`. Default `"global"`. */
  defaultScope?: string;
  /**
   * Inflight lease (ms) applied by `begin` when a call omits `inflightTtlMs`.
   * Short by design so a crashed worker's claim self-heals. Default `60_000`.
   */
  defaultInflightTtlMs?: number;
  /**
   * Grace window (ms) applied by `complete` when a call omits `doneTtlMs` —
   * how long a recorded outcome replays before the key may be re-minted.
   * Default `86_400_000` (24h).
   */
  defaultDoneTtlMs?: number;
  /**
   * When set, `complete` upserts the key as `done` even if its inflight row had
   * vanished (`missing`/`expired`) — recording finished work rather than dropping
   * it. Default `false`. Overridable per `complete` call.
   */
  upsertOnMissing?: boolean;
  /**
   * Validates/narrows a stored `result` to `TResult` at the boundary. Applied to
   * the `result` returned by `begin` (`done` replay) and `get`, and to the
   * `result` passed into `complete` before it is stored. Throws on a mismatch.
   */
  resultValidator?: ResultParser<TResult>;
}

/** A key's stored state, as returned by {@link Idempotency.get}. */
export interface KeyState<TResult> {
  /** `inflight` while an attempt holds the key, `done` once completed. */
  status: "inflight" | "done";
  /** The recorded outcome, present only when `status` is `done`. */
  result?: TResult;
  /** Absolute ms timestamp after which the key may be re-minted. */
  expiresAt: number;
}
