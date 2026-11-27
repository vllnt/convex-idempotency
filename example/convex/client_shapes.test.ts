import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { Idempotency } from "../../src/client/index";
import { register } from "../../src/test";
import { components } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/**
 * Calls the client inside `t.run`, so its return values are seen as built,
 * without the serialization that a host function boundary applies.
 */
function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}

const idem = new Idempotency<number | boolean | string | null>(
  components.idempotency,
);

describe("client return shapes", () => {
  test("begin and get leave `result` out when none was stored", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      const claim = await idem.begin(ctx, "no_result");
      if (claim.state !== "fresh") throw new Error("expected fresh");
      expect(
        await idem.complete(ctx, "no_result", undefined, {
          claimId: claim.claimId,
        }),
      ).toStrictEqual({ recorded: true });

      const replay = await idem.begin(ctx, "no_result");
      expect(replay).toStrictEqual({ state: "done" });
      expect("result" in replay).toBe(false);

      const state = await idem.get(ctx, "no_result");
      expect(state).not.toBeNull();
      expect(state !== null && "result" in state).toBe(false);
      expect(state?.status).toBe("done");
    });
  });

  test("falsy results are stored and replayed, not dropped", async () => {
    const t = setup();
    const values = [0, false, "", null] as const;
    await t.run(async (ctx) => {
      for (const [index, value] of values.entries()) {
        const key = `falsy_${String(index)}`;
        const claim = await idem.begin(ctx, key);
        if (claim.state !== "fresh") throw new Error("expected fresh");
        await idem.complete(ctx, key, value, { claimId: claim.claimId });
        expect(await idem.begin(ctx, key)).toStrictEqual({
          state: "done",
          result: value,
        });
        expect((await idem.get(ctx, key))?.result).toBe(value);
      }
    });
  });
});
