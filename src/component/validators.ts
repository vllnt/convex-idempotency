import { v } from "convex/values";

/**
 * Opaque host-owned outcome stored against a completed key. The component never
 * inspects it — last-resort arbitrary data, aliased here rather than left bare
 * in function signatures. The host narrows it at the {@link Idempotency} client
 * boundary via an optional `resultValidator`.
 *
 * This is the single documented `v.any()` escape hatch in the component; the
 * lint rule `convex-rules/no-bare-v-any` is satisfied by routing every arbitrary
 * payload through this alias instead of a bare `v.any()`.
 */
export const jsonValue = v.any();

/**
 * Result of {@link begin}. `fresh` — the key was just minted, the caller should
 * do the work and then `complete`. `inflight` — another attempt holds the key;
 * `expiresAt` is when the lease frees and `retryAfterMs` how long to back off
 * before retrying. `done` — a prior attempt already completed; `result` carries
 * the recorded outcome for a short-circuit replay.
 */
export const beginResult = v.union(
  v.object({ state: v.literal("fresh") }),
  v.object({
    state: v.literal("inflight"),
    expiresAt: v.number(),
    retryAfterMs: v.number(),
  }),
  v.object({ state: v.literal("done"), result: v.optional(jsonValue) }),
);

/**
 * Result of {@link complete}. `recorded: true` — the outcome was written.
 * `recorded: false` — the claim was lost; `reason` distinguishes a never-claimed
 * key (`missing`), a lease that expired before completion (`expired`), and a key
 * already marked done by a prior attempt (`already_done`). A host that sees
 * `recorded: false` knows its work finished but the ledger row was gone.
 */
export const completeResult = v.union(
  v.object({ recorded: v.literal(true) }),
  v.object({
    recorded: v.literal(false),
    reason: v.union(
      v.literal("missing"),
      v.literal("expired"),
      v.literal("already_done"),
    ),
  }),
);

/** Stored projection of a key returned by {@link get}. */
export const keyState = v.object({
  status: v.union(v.literal("inflight"), v.literal("done")),
  result: v.optional(jsonValue),
  expiresAt: v.number(),
});
