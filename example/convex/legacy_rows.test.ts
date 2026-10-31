import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../src/component/_generated/api";
import schema from "../../src/component/schema";

const modules = import.meta.glob("../../src/component/**/*.ts");

describe("idempotency — rows stored before claim fencing", () => {
  test("a row without claimGeneration counts as generation 1 and completes without a claim token", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("keys", {
        key: "legacy_row",
        scope: "default",
        status: "inflight",
        expiresAt: Date.now() + 60_000,
      });
    });
    expect(
      await t.mutation(api.mutations.complete, {
        key: "legacy_row",
        scope: "default",
        doneTtlMs: 1_000,
        upsertOnMissing: false,
      }),
    ).toEqual({ recorded: true });
    expect(
      await t.query(api.queries.get, { key: "legacy_row", scope: "default" }),
    ).toMatchObject({ status: "done" });
  });
});
