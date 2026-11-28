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

  test("an expired row without claimGeneration re-mints as generation 2 and fences a token-less complete", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      ctx.db.insert("keys", {
        key: "legacy_expired",
        scope: "default",
        status: "inflight",
        expiresAt: Date.now() - 1,
      }),
    );
    const claim = await t.mutation(api.mutations.begin, {
      key: "legacy_expired",
      scope: "default",
      inflightTtlMs: 60_000,
    });
    if (claim.state !== "fresh") throw new Error("expected fresh");
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({
      status: "inflight",
      claimId: claim.claimId,
      claimGeneration: 2,
    });

    // the old worker never had a claim token: after the re-mint it is superseded
    expect(
      await t.mutation(api.mutations.complete, {
        key: "legacy_expired",
        scope: "default",
        result: "stale",
        doneTtlMs: 1_000,
        upsertOnMissing: true,
      }),
    ).toStrictEqual({ recorded: false, reason: "superseded" });
    // the new claim holder still completes
    expect(
      await t.mutation(api.mutations.complete, {
        key: "legacy_expired",
        scope: "default",
        result: "fresh",
        claimId: claim.claimId,
        doneTtlMs: 1_000,
        upsertOnMissing: false,
      }),
    ).toStrictEqual({ recorded: true });
    expect(
      await t.query(api.queries.get, {
        key: "legacy_expired",
        scope: "default",
      }),
    ).toMatchObject({ status: "done", result: "fresh" });
  });
});
