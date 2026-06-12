/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    mutations: {
      begin: FunctionReference<
        "mutation",
        "internal",
        { inflightTtlMs: number; key: string; scope: string },
        | { state: "fresh" }
        | { expiresAt: number; retryAfterMs: number; state: "inflight" }
        | { result?: any; state: "done" },
        Name
      >;
      complete: FunctionReference<
        "mutation",
        "internal",
        {
          doneTtlMs: number;
          key: string;
          result?: any;
          scope: string;
          upsertOnMissing: boolean;
        },
        | { recorded: true }
        | { reason: "missing" | "expired" | "already_done"; recorded: false },
        Name
      >;
      purge: FunctionReference<
        "mutation",
        "internal",
        { batch: number; before?: number },
        number,
        Name
      >;
    };
    queries: {
      get: FunctionReference<
        "query",
        "internal",
        { key: string; scope: string },
        null | { expiresAt: number; result?: any; status: "inflight" | "done" },
        Name
      >;
    };
  };
