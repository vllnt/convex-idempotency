import { convexTest } from "convex-test";
import { componentsGeneric } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Idempotency } from "../../src/client/index";
import type { ComponentApi } from "../../src/component/_generated/component";
import { register } from "../../src/test";
import { api, components } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}

/** Asserts that `call` rejects with a `ConvexError` whose `data` is exactly `{ code, message }`. */
async function expectConvexError(
  call: Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  const error: unknown = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConvexError);
  expect(
    (error as ConvexError<{ code: string; message: string }>).data,
  ).toStrictEqual({
    code,
    message,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TTL values that are not positive finite numbers", () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "begin rejects inflightTtlMs %s with INVALID_TTL and writes no row",
    async (inflightTtlMs) => {
      const t = setup();
      await expectConvexError(
        t.mutation(api.example.begin, { key: "ttl_in", inflightTtlMs }),
        "INVALID_TTL",
        "inflightTtlMs must be a positive finite number",
      );
      expect(await t.query(api.example.get, { key: "ttl_in" })).toBeNull();
    },
  );

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "complete rejects doneTtlMs %s with INVALID_TTL and writes nothing",
    async (doneTtlMs) => {
      const t = setup();
      // a missing key with upsertOnMissing would otherwise insert a done row
      await expectConvexError(
        t.mutation(api.example.complete, {
          key: "ttl_missing",
          doneTtlMs,
          upsertOnMissing: true,
        }),
        "INVALID_TTL",
        "doneTtlMs must be a positive finite number",
      );
      expect(await t.query(api.example.get, { key: "ttl_missing" })).toBeNull();

      // an inflight row stays inflight, with its lease unchanged
      await t.mutation(api.example.begin, {
        key: "ttl_live",
        inflightTtlMs: 500,
      });
      await expectConvexError(
        t.mutation(api.example.complete, {
          key: "ttl_live",
          result: 1,
          doneTtlMs,
        }),
        "INVALID_TTL",
        "doneTtlMs must be a positive finite number",
      );
      expect(await t.query(api.example.get, { key: "ttl_live" })).toStrictEqual(
        {
          status: "inflight",
          expiresAt: 500,
        },
      );
    },
  );
});

describe("client options", () => {
  test('defaultScope: "" throws INVALID_SCOPE on begin and complete', async () => {
    const t = setup();
    const emptyScope = new Idempotency(components.idempotency, {
      defaultScope: "",
    });
    await t.run(async (ctx) => {
      await expectConvexError(
        emptyScope.begin(ctx, "k"),
        "INVALID_SCOPE",
        "scope must not be empty",
      );
      await expectConvexError(
        emptyScope.complete(ctx, "k", "r", { upsertOnMissing: true }),
        "INVALID_SCOPE",
        "scope must not be empty",
      );
      // nothing was written under the empty scope
      expect(await emptyScope.get(ctx, "k")).toBeNull();
    });
  });

  test("defaultInflightTtlMs sets the lease and defaultDoneTtlMs the done grace", async () => {
    const t = setup();
    const custom = new Idempotency<string>(components.idempotency, {
      defaultScope: "custom_ttl",
      defaultInflightTtlMs: 5_000,
      defaultDoneTtlMs: 7_000,
    });
    // convex-test pins the clock for each top-level transaction, so each step is its own `t.run`
    vi.setSystemTime(1_000);
    const claim = await t.run(async (ctx) => {
      const r = await custom.begin(ctx, "k");
      expect(await custom.get(ctx, "k")).toStrictEqual({
        status: "inflight",
        expiresAt: 6_000,
      });
      return r;
    });
    if (claim.state !== "fresh") throw new Error("expected fresh");
    vi.setSystemTime(2_000);
    await t.run(async (ctx) => {
      expect(
        await custom.complete(ctx, "k", "ok", { claimId: claim.claimId }),
      ).toStrictEqual({
        recorded: true,
      });
      expect(await custom.get(ctx, "k")).toStrictEqual({
        status: "done",
        result: "ok",
        expiresAt: 9_000,
      });
    });
  });

  test("a per-call upsertOnMissing: false overrides a client default of true", async () => {
    const t = setup();
    const upserting = new Idempotency<number>(components.idempotency, {
      defaultScope: "upsert_default",
      upsertOnMissing: true,
    });
    await t.run(async (ctx) => {
      expect(
        await upserting.complete(ctx, "never_claimed", 1, {
          upsertOnMissing: false,
        }),
      ).toStrictEqual({ recorded: false, reason: "missing" });
      expect(await upserting.get(ctx, "never_claimed")).toBeNull();
      // an explicit undefined falls back to the client default (true)
      expect(
        await upserting.complete(ctx, "never_claimed", 2, {
          upsertOnMissing: undefined,
        }),
      ).toStrictEqual({ recorded: true });
      expect((await upserting.get(ctx, "never_claimed"))?.result).toBe(2);
    });
  });

  test("upsertOnMissing on an expired done key returns already_done and keeps the result", async () => {
    const t = setup();
    await t.mutation(api.example.begin, {
      key: "exp_done_upsert",
      inflightTtlMs: 100,
    });
    vi.setSystemTime(50);
    await t.mutation(api.example.complete, {
      key: "exp_done_upsert",
      result: "original",
      doneTtlMs: 10,
    });
    vi.setSystemTime(500); // done grace (expiresAt 60) lapsed
    expect(
      await t.mutation(api.example.complete, {
        key: "exp_done_upsert",
        result: "late",
        upsertOnMissing: true,
      }),
    ).toStrictEqual({ recorded: false, reason: "already_done" });
    expect(
      await t.query(api.example.get, { key: "exp_done_upsert" }),
    ).toStrictEqual({
      status: "done",
      result: "original",
      expiresAt: 60,
    });
  });
});

describe("resultValidator failures on read", () => {
  test("begin (done replay) and get throw when the stored value fails the validator", async () => {
    const t = setup();
    // `idem` has no validator; write into the strict client's scope
    expect(
      await t.mutation(api.example.complete, {
        key: "bad_stored",
        scope: "strict",
        result: { ok: "nope" },
        upsertOnMissing: true,
      }),
    ).toStrictEqual({ recorded: true });
    await expect(
      t.mutation(api.example.beginStrict, { key: "bad_stored" }),
    ).rejects.toThrow("invalid result: expected { ok: boolean }");
    await expect(
      t.query(api.example.getStrict, { key: "bad_stored" }),
    ).rejects.toThrow("invalid result: expected { ok: boolean }");
    // the raw value is still stored, unchanged
    expect(
      (await t.query(api.example.get, { key: "bad_stored", scope: "strict" }))
        ?.result,
    ).toStrictEqual({ ok: "nope" });
  });
});

describe("expiry boundaries (expiresAt == now)", () => {
  test("begin re-mints fresh when expiresAt equals now", async () => {
    const t = setup();
    const first = await t.mutation(api.example.begin, {
      key: "edge_begin",
      inflightTtlMs: 10,
    });
    vi.setSystemTime(9);
    expect(
      await t.mutation(api.example.begin, { key: "edge_begin" }),
    ).toStrictEqual({
      state: "inflight",
      expiresAt: 10,
      retryAfterMs: 1,
    });
    vi.setSystemTime(10);
    const second = await t.mutation(api.example.begin, {
      key: "edge_begin",
      inflightTtlMs: 10,
    });
    expect(second.state).toBe("fresh");
    expect(second).not.toStrictEqual(first);
  });

  test("complete returns expired when expiresAt equals now", async () => {
    const t = setup();
    await t.mutation(api.example.begin, {
      key: "edge_complete",
      inflightTtlMs: 10,
    });
    vi.setSystemTime(10);
    expect(
      await t.mutation(api.example.complete, {
        key: "edge_complete",
        result: 1,
      }),
    ).toStrictEqual({ recorded: false, reason: "expired" });
  });

  test("purge keeps a key whose expiresAt equals before (strict <)", async () => {
    const t = setup();
    await t.mutation(api.example.begin, {
      key: "edge_purge",
      inflightTtlMs: 10,
    });
    expect(
      await t.mutation(api.example.purge, { before: 10, batch: 200 }),
    ).toBe(0);
    expect(
      await t.query(api.example.get, { key: "edge_purge" }),
    ).not.toBeNull();
    expect(
      await t.mutation(api.example.purge, { before: 11, batch: 200 }),
    ).toBe(1);
    expect(await t.query(api.example.get, { key: "edge_purge" })).toBeNull();
  });
});

describe("purge details", () => {
  test.each([1, 500])("accepts batch %s", async (batch) => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "one", inflightTtlMs: 1 });
    expect(await t.mutation(api.example.purge, { before: 100, batch })).toBe(1);
    expect(await t.query(api.example.get, { key: "one" })).toBeNull();
  });

  test.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects before %s with INVALID_BEFORE",
    async (before) => {
      const t = setup();
      await expectConvexError(
        t.mutation(api.example.purge, { before }),
        "INVALID_BEFORE",
        "before must be finite",
      );
    },
  );

  test("deletes the oldest key first", async () => {
    const t = setup();
    // minted out of expiry order
    await t.mutation(api.example.begin, { key: "c", inflightTtlMs: 30 });
    await t.mutation(api.example.begin, { key: "a", inflightTtlMs: 10 });
    await t.mutation(api.example.begin, { key: "b", inflightTtlMs: 20 });
    expect(
      await t.mutation(api.example.purge, { before: 1_000, batch: 1 }),
    ).toBe(1);
    expect(await t.query(api.example.get, { key: "a" })).toBeNull();
    expect(await t.query(api.example.get, { key: "b" })).not.toBeNull();
    expect(await t.query(api.example.get, { key: "c" })).not.toBeNull();
    // the self-rescheduled pass takes the next oldest
    vi.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
    expect(await t.query(api.example.get, { key: "b" })).toBeNull();
    expect(await t.query(api.example.get, { key: "c" })).not.toBeNull();
  });

  test("re-scheduled passes keep the first pass's cutoff", async () => {
    const t = setup();
    for (const key of ["x1", "x2", "x3"]) {
      await t.mutation(api.example.begin, { key, inflightTtlMs: 10 }); // expires by 12
    }
    vi.setSystemTime(100);
    await t.mutation(api.example.begin, { key: "later", inflightTtlMs: 1_400 }); // expiresAt 1_500
    vi.setSystemTime(1_000);
    // no `before`: the first pass uses server now (1_000) as the cutoff
    expect(await t.mutation(api.example.purge, { batch: 2 })).toBe(2);
    // "later" expires before the follow-up pass runs
    vi.setSystemTime(2_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const key of ["x1", "x2", "x3"]) {
      expect(await t.query(api.example.get, { key })).toBeNull();
    }
    expect(await t.query(api.example.get, { key: "later" })).toStrictEqual({
      status: "inflight",
      expiresAt: 1_500,
    });
  });

  test("re-running with a past cutoff removes nothing new", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "gone", inflightTtlMs: 10 });
    await t.mutation(api.example.begin, { key: "kept", inflightTtlMs: 1_000 });
    expect(
      await t.mutation(api.example.purge, { before: 100, batch: 200 }),
    ).toBe(1);
    expect(
      await t.mutation(api.example.purge, { before: 100, batch: 200 }),
    ).toBe(0);
    expect(await t.query(api.example.get, { key: "kept" })).not.toBeNull();
  });
});

describe("register with a custom mount name", () => {
  test('register(t, "second") mounts a separate ledger a client can use', async () => {
    const t = convexTest(schema, modules);
    register(t);
    register(t, "second");
    // `components` is a runtime proxy; the example app's generated types only know `idempotency`
    const secondRef = componentsGeneric()
      .second as unknown as ComponentApi<"second">;
    const second = new Idempotency<string>(secondRef);
    await t.run(async (ctx) => {
      const claim = await second.begin(ctx, "k");
      if (claim.state !== "fresh") throw new Error("expected fresh");
      expect(
        await second.complete(ctx, "k", "from_second", {
          claimId: claim.claimId,
        }),
      ).toStrictEqual({
        recorded: true,
      });
      expect(await second.begin(ctx, "k")).toStrictEqual({
        state: "done",
        result: "from_second",
      });
    });
    // the default mount is a different ledger: the same key is still unclaimed there
    expect(await t.query(api.example.get, { key: "k" })).toBeNull();
    expect((await t.mutation(api.example.begin, { key: "k" })).state).toBe(
      "fresh",
    );
  });
});

describe("get with empty input", () => {
  test('get("") does not throw and returns null', async () => {
    const t = setup();
    expect(await t.query(api.example.get, { key: "" })).toBeNull();
    expect(await t.query(api.example.get, { key: "k", scope: "" })).toBeNull();
    expect(await t.query(api.example.get, { key: "", scope: "" })).toBeNull();
  });
});

describe("document size limit", () => {
  test("a result over 1 MiB is rejected and the claim stays inflight", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "big", inflightTtlMs: 1_000 });
    await expect(
      t.mutation(api.example.complete, {
        key: "big",
        result: "x".repeat(1 << 20),
      }),
    ).rejects.toThrow(/Value is too large/);
    expect(await t.query(api.example.get, { key: "big" })).toStrictEqual({
      status: "inflight",
      expiresAt: 1_000,
    });
  });
});
