import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type {
  BeginResult,
  CompleteResult,
  IdempotencyOptions,
  KeyState,
  ResultParser,
} from "./types.js";
import {
  DEFAULT_DONE_TTL_MS,
  DEFAULT_INFLIGHT_TTL_MS,
  DEFAULT_PURGE_BATCH,
  DEFAULT_SCOPE,
} from "../shared.js";

/**
 * The component's raw `begin` return, before the client narrows `result`. The
 * stored outcome is opaque here (`unknown`); the {@link Idempotency} client runs
 * the host `resultValidator` over it at its typed boundary.
 */
type RawBegin =
  | { state: "fresh" }
  | { state: "inflight"; expiresAt: number; retryAfterMs: number }
  | { state: "done"; result?: unknown };

/**
 * The idempotency component's function references, as exposed on the host via
 * `components.idempotency`. The host's stored outcome type is opaque here
 * (`unknown`); the {@link Idempotency} client narrows it to `TResult` at its
 * own typed boundary.
 */
export interface IdempotencyComponent {
  mutations: {
    begin: FunctionReference<
      "mutation",
      "internal",
      { key: string; scope: string; inflightTtlMs: number },
      RawBegin
    >;
    complete: FunctionReference<
      "mutation",
      "internal",
      {
        key: string;
        scope: string;
        result?: unknown;
        doneTtlMs: number;
        upsertOnMissing: boolean;
      },
      CompleteResult
    >;
    purge: FunctionReference<
      "mutation",
      "internal",
      { before?: number; batch: number },
      number
    >;
  };
  queries: {
    get: FunctionReference<
      "query",
      "internal",
      { key: string; scope: string },
      {
        status: "inflight" | "done";
        result?: unknown;
        expiresAt: number;
      } | null
    >;
  };
}

interface RunQueryCtx {
  runQuery<Q extends FunctionReference<"query", "internal">>(
    reference: Q,
    args: FunctionArgs<Q>,
  ): Promise<FunctionReturnType<Q>>;
}

interface RunMutationCtx {
  runMutation<M extends FunctionReference<"mutation", "internal">>(
    reference: M,
    args: FunctionArgs<M>,
  ): Promise<FunctionReturnType<M>>;
}

/** Per-call overrides for `scope` and the inflight lease. */
interface BeginOptions {
  scope?: string;
  inflightTtlMs?: number;
}

/** Per-call overrides for `scope`, the done grace window, and lost-claim upsert. */
interface CompleteOptions {
  scope?: string;
  doneTtlMs?: number;
  upsertOnMissing?: boolean;
}

/**
 * Consumer-facing client for the exactly-once idempotency key ledger. The host
 * owns meaning and auth; it passes an opaque `key` and an optional `scope`, and
 * stores an arbitrary `TResult` outcome that replays return verbatim. Pass a
 * `resultValidator` to narrow the opaque stored value to `TResult` at the
 * boundary — there is no unchecked cast.
 *
 * @typeParam TResult - The host's stored outcome type (defaults to `unknown`).
 *
 * @example
 * ```ts
 * const idem = new Idempotency(components.idempotency, {
 *   resultValidator: v.object({ chargeId: v.string() }).parse,
 * });
 * const r = await idem.begin(ctx, requestId);
 * if (r.state === "done") return r.result;                  // typed replay
 * if (r.state === "inflight") throw new Error(`retry in ${r.retryAfterMs}ms`);
 * const out = await doWork();                               // r.state === "fresh"
 * const done = await idem.complete(ctx, requestId, out);
 * if (!done.recorded) log.warn("claim lost", done.reason);  // work ran, row gone
 * ```
 */
export class Idempotency<TResult = unknown> {
  private readonly defaultScope: string;
  private readonly defaultInflightTtlMs: number;
  private readonly defaultDoneTtlMs: number;
  private readonly defaultUpsertOnMissing: boolean;
  private readonly resultValidator: ResultParser<TResult> | undefined;

  constructor(
    private readonly component: IdempotencyComponent,
    options: IdempotencyOptions<TResult> = {},
  ) {
    this.defaultScope = options.defaultScope ?? DEFAULT_SCOPE;
    this.defaultInflightTtlMs =
      options.defaultInflightTtlMs ?? DEFAULT_INFLIGHT_TTL_MS;
    this.defaultDoneTtlMs = options.defaultDoneTtlMs ?? DEFAULT_DONE_TTL_MS;
    this.defaultUpsertOnMissing = options.upsertOnMissing ?? false;
    this.resultValidator = options.resultValidator;
  }

  private scopeOf(scope: string | undefined): string {
    return scope ?? this.defaultScope;
  }

  /**
   * Narrow an opaque stored `result` to `TResult` via the host validator. Absent
   * values pass through untouched; with no validator the value is returned as-is
   * (the host accepted the unchecked-type tradeoff by omitting one).
   */
  private parseResult(value: unknown): TResult | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (this.resultValidator === undefined) {
      return value as TResult;
    }
    return this.resultValidator(value);
  }

  /**
   * Claim `key`. `fresh` mints an inflight key (do the work, then `complete`);
   * `inflight` means a concurrent attempt holds it — back off `retryAfterMs`;
   * `done` returns the validated recorded `result` for a short-circuit replay.
   */
  async begin(
    ctx: RunMutationCtx,
    key: string,
    opts: BeginOptions = {},
  ): Promise<BeginResult<TResult>> {
    const r: RawBegin = await ctx.runMutation(this.component.mutations.begin, {
      key,
      scope: this.scopeOf(opts.scope),
      inflightTtlMs: opts.inflightTtlMs ?? this.defaultInflightTtlMs,
    });
    if (r.state === "done") {
      return { state: "done", result: this.parseResult(r.result) };
    }
    return r;
  }

  /**
   * Mark `key` `done`, recording `result` and extending the done grace window.
   * Returns a discriminated outcome: `recorded: true` on success, or
   * `recorded: false` with a `reason` when the claim was lost (missing, expired,
   * or already done) so the host can react to dropped work. `result` is validated
   * against the host validator before it is stored.
   */
  complete(
    ctx: RunMutationCtx,
    key: string,
    result?: TResult,
    opts: CompleteOptions = {},
  ): Promise<CompleteResult> {
    const validated =
      result === undefined ? undefined : this.parseResult(result);
    return ctx.runMutation(this.component.mutations.complete, {
      key,
      scope: this.scopeOf(opts.scope),
      result: validated,
      doneTtlMs: opts.doneTtlMs ?? this.defaultDoneTtlMs,
      upsertOnMissing: opts.upsertOnMissing ?? this.defaultUpsertOnMissing,
    });
  }

  /** The stored state for `key`, or `null` if no key is held in the scope. */
  async get(
    ctx: RunQueryCtx,
    key: string,
    scope?: string,
  ): Promise<KeyState<TResult> | null> {
    const row = await ctx.runQuery(this.component.queries.get, {
      key,
      scope: this.scopeOf(scope),
    });
    if (row === null) {
      return null;
    }
    return {
      status: row.status,
      result: this.parseResult(row.result),
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Delete expired keys in bounded batches, oldest first. `before` defaults to
   * the server clock; `batch` caps each pass and the sweep self-reschedules until
   * the tail is clean. Returns the count removed in the first pass.
   */
  purge(
    ctx: RunMutationCtx,
    opts: { before?: number; batch?: number } = {},
  ): Promise<number> {
    return ctx.runMutation(this.component.mutations.purge, {
      before: opts.before,
      batch: opts.batch ?? DEFAULT_PURGE_BATCH,
    });
  }
}

export type {
  BeginResult,
  CompleteResult,
  IdempotencyOptions,
  KeyState,
  ResultParser,
};
