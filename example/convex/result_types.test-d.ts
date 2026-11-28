import { expectTypeOf, test } from "vitest";
import type { BeginResult, CompleteResult } from "../../src/client/index";

/** Type-level checks on the public result unions. */
type Done<T> = Extract<BeginResult<T>, { state: "done" }>;
type Lost = Extract<CompleteResult, { recorded: false }>;

test("CompleteResult's reason union is exactly the four lost-claim reasons", () => {
  expectTypeOf<Lost["reason"]>().toEqualTypeOf<
    "missing" | "expired" | "superseded" | "already_done"
  >();
  expectTypeOf<Extract<CompleteResult, { recorded: true }>>().toEqualTypeOf<{
    recorded: true;
  }>();
});

test("BeginResult<T> done result is T | undefined and may be left out", () => {
  expectTypeOf<Done<{ id: string }>["result"]>().toEqualTypeOf<
    { id: string } | undefined
  >();
  // `result` is optional: a done replay without a stored result fits
  expectTypeOf<{ state: "done" }>().toExtend<BeginResult<{ id: string }>>();
  expectTypeOf<{ state: "done"; result: number }>().not.toExtend<
    BeginResult<{ id: string }>
  >();
});

test("BeginResult discriminates on state", () => {
  expectTypeOf<BeginResult<unknown>["state"]>().toEqualTypeOf<
    "fresh" | "inflight" | "done"
  >();
  expectTypeOf<
    Extract<BeginResult<unknown>, { state: "fresh" }>
  >().toEqualTypeOf<{
    state: "fresh";
    claimId: string;
  }>();
});
