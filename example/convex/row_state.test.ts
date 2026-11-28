import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../src/component/_generated/api";
import schema from "../../src/component/schema";

const modules = import.meta.glob("../../src/component/**/*.ts");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("idempotency — stored row after a re-mint", () => {
  test("begin on an expired done key clears the old result and keeps the row _id", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.mutations.begin, {
      key: "remint",
      scope: "s",
      inflightTtlMs: 100,
    });
    if (first.state !== "fresh") throw new Error("expected fresh");
    vi.setSystemTime(10);
    expect(
      await t.mutation(api.mutations.complete, {
        key: "remint",
        scope: "s",
        result: { old: true },
        claimId: first.claimId,
        doneTtlMs: 10,
        upsertOnMissing: false,
      }),
    ).toStrictEqual({ recorded: true });
    const before = await t.run((ctx) => ctx.db.query("keys").unique());
    expect(before).toMatchObject({
      status: "done",
      result: { old: true },
      claimId: first.claimId,
      claimGeneration: 1,
      expiresAt: 20,
    });

    vi.setSystemTime(100); // done grace (expiresAt 20) lapsed
    const second = await t.mutation(api.mutations.begin, {
      key: "remint",
      scope: "s",
      inflightTtlMs: 50,
    });
    if (second.state !== "fresh") throw new Error("expected fresh");

    const rows = await t.run((ctx) => ctx.db.query("keys").collect());
    expect(rows).toHaveLength(1);
    const after = rows[0];
    expect(after?._id).toBe(before?._id);
    expect(after?._creationTime).toBe(before?._creationTime);
    expect(after).not.toHaveProperty("result");
    expect(after).toMatchObject({
      status: "inflight",
      claimId: second.claimId,
      claimGeneration: 2,
      expiresAt: 150,
    });
    expect(second.claimId).not.toBe(first.claimId);
  });
});
