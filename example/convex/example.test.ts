import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { register } from "../../src/test";
import crons, {
  PRUNE_BATCH,
  PRUNE_INTERVAL,
} from "../../src/component/crons";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("idempotency — begin / complete lifecycle", () => {
  test("first begin mints a fresh inflight key (happy path)", async () => {
    const t = setup();
    const r = await t.mutation(api.example.begin, { key: "op_1" });
    expect(r).toEqual({ state: "fresh" });
    const state = await t.query(api.example.get, { key: "op_1" });
    expect(state?.status).toBe("inflight");
    expect(state?.result).toBeUndefined();
    // default inflight ttl 60_000 stamped from server time (now=0)
    expect(state?.expiresAt).toBe(60_000);
  });

  test("a second begin while inflight short-circuits with backoff hint", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "op_2", inflightTtlMs: 60_000 });
    vi.setSystemTime(1_000);
    const r = await t.mutation(api.example.begin, { key: "op_2" });
    expect(r).toEqual({
      state: "inflight",
      expiresAt: 60_000,
      retryAfterMs: 59_000,
    });
  });

  test("complete then begin replays the recorded result (done)", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "op_3" });
    expect(
      await t.mutation(api.example.complete, {
        key: "op_3",
        result: { chargeId: "ch_42" },
      }),
    ).toEqual({ recorded: true });
    const r = await t.mutation(api.example.begin, { key: "op_3" });
    expect(r).toEqual({ state: "done", result: { chargeId: "ch_42" } });
    const state = await t.query(api.example.get, { key: "op_3" });
    expect(state?.status).toBe("done");
    expect(state?.result).toEqual({ chargeId: "ch_42" });
    // done grace window stamped (now=0 + default doneTtl 86_400_000)
    expect(state?.expiresAt).toBe(86_400_000);
  });

  test("complete with no result records done with undefined result", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "op_void" });
    expect(await t.mutation(api.example.complete, { key: "op_void" })).toEqual({
      recorded: true,
    });
    const r = await t.mutation(api.example.begin, { key: "op_void" });
    expect(r).toEqual({ state: "done" });
  });
});

describe("idempotency — complete discriminated outcome (lost claim)", () => {
  test("complete on a never-claimed key reports recorded:false missing", async () => {
    const t = setup();
    expect(await t.mutation(api.example.complete, { key: "ghost" })).toEqual({
      recorded: false,
      reason: "missing",
    });
    expect(await t.query(api.example.get, { key: "ghost" })).toBeNull();
  });

  test("a second complete on a done key reports recorded:false already_done", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "op_dd" });
    await t.mutation(api.example.complete, { key: "op_dd", result: "first" });
    expect(
      await t.mutation(api.example.complete, { key: "op_dd", result: "second" }),
    ).toEqual({ recorded: false, reason: "already_done" });
    // the first result is preserved
    const r = await t.mutation(api.example.begin, { key: "op_dd" });
    expect(r).toEqual({ state: "done", result: "first" });
  });

  test("complete after the inflight lease expired reports recorded:false expired", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "op_late", inflightTtlMs: 10 });
    vi.setSystemTime(100); // lease (expiresAt 10) lapsed
    expect(
      await t.mutation(api.example.complete, { key: "op_late", result: "x" }),
    ).toEqual({ recorded: false, reason: "expired" });
  });

  test("complete after the inflight row was purged reports recorded:false missing", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "op_purged", inflightTtlMs: 10 });
    vi.setSystemTime(100);
    // purge sweeps the expired inflight row, then the worker completes late
    expect(await t.mutation(api.example.purge, { before: 100, batch: 200 })).toBe(1);
    expect(
      await t.mutation(api.example.complete, { key: "op_purged", result: "x" }),
    ).toEqual({ recorded: false, reason: "missing" });
  });
});

describe("idempotency — upsertOnMissing (record lost work)", () => {
  test("strict client upserts a done row when the claim was missing", async () => {
    const t = setup();
    // never began — strict client has upsertOnMissing:true
    expect(
      await t.mutation(api.example.completeStrict, {
        key: "u_missing",
        result: { ok: true },
      }),
    ).toEqual({ recorded: true });
    const state = await t.query(api.example.getStrict, { key: "u_missing" });
    expect(state?.status).toBe("done");
    expect(state?.result).toEqual({ ok: true });
  });

  test("strict client upserts a done row when the lease had expired", async () => {
    const t = setup();
    await t.mutation(api.example.beginStrict, { key: "u_exp" });
    vi.setSystemTime(2_000); // strict inflight ttl default 60_000? begin uses 60_000 → not expired
    // force expiry by advancing past the default inflight ttl
    vi.setSystemTime(60_001);
    expect(
      await t.mutation(api.example.completeStrict, {
        key: "u_exp",
        result: { ok: false },
      }),
    ).toEqual({ recorded: true });
    const state = await t.query(api.example.getStrict, { key: "u_exp" });
    expect(state?.result).toEqual({ ok: false });
  });
});

describe("idempotency — host result validator", () => {
  test("a result failing the host validator is rejected before storage", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.completeStrict, {
        key: "bad",
        result: { ok: "nope" },
      }),
    ).rejects.toThrow(/invalid result/);
    // nothing was stored
    expect(await t.query(api.example.getStrict, { key: "bad" })).toBeNull();
  });
});

describe("idempotency — expiry (deterministic server time)", () => {
  test("begin after the inflight lease expires re-mints fresh, reusing the row", async () => {
    const t = setup();
    const first = await t.mutation(api.example.begin, {
      key: "op_exp",
      inflightTtlMs: 1,
    });
    expect(first).toEqual({ state: "fresh" });
    const rowBefore = await t.query(api.example.get, { key: "op_exp" });
    vi.setSystemTime(5); // expiresAt 1 <= 5 → expired
    const second = await t.mutation(api.example.begin, {
      key: "op_exp",
      inflightTtlMs: 1,
    });
    expect(second).toEqual({ state: "fresh" });
    const rowAfter = await t.query(api.example.get, { key: "op_exp" });
    // reused in place: fresh inflight lease, no stale result
    expect(rowAfter?.status).toBe("inflight");
    expect(rowAfter?.result).toBeUndefined();
    expect(rowAfter?.expiresAt).toBe(6);
    expect(rowBefore?.expiresAt).toBe(1);
  });

  test("expired done key is re-minted fresh, not replayed", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "op_done_exp", inflightTtlMs: 10 });
    await t.mutation(api.example.complete, {
      key: "op_done_exp",
      result: "old",
      doneTtlMs: 10,
    });
    vi.setSystemTime(100); // done grace (expiresAt 10) expired
    const r = await t.mutation(api.example.begin, {
      key: "op_done_exp",
      inflightTtlMs: 10,
    });
    expect(r).toEqual({ state: "fresh" });
  });
});

describe("idempotency — concurrency", () => {
  test("concurrent begin on one key yields exactly one fresh", async () => {
    const t = setup();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        t.mutation(api.example.begin, { key: "race" }),
      ),
    );
    const fresh = attempts.filter((a) => a.state === "fresh");
    const inflight = attempts.filter((a) => a.state === "inflight");
    expect(fresh).toHaveLength(1);
    expect(inflight).toHaveLength(7);
  });
});

describe("idempotency — get projection", () => {
  test("get returns null for a missing key, projection for inflight + done", async () => {
    const t = setup();
    expect(await t.query(api.example.get, { key: "absent" })).toBeNull();
    await t.mutation(api.example.begin, { key: "op_g" });
    const inflight = await t.query(api.example.get, { key: "op_g" });
    expect(inflight?.status).toBe("inflight");
    await t.mutation(api.example.complete, { key: "op_g", result: 7 });
    const done = await t.query(api.example.get, { key: "op_g" });
    expect(done?.status).toBe("done");
    expect(done?.result).toBe(7);
  });
});

describe("idempotency — purge (bounded + self-rescheduling)", () => {
  test("purge removes only keys expired before the cutoff and returns the count", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "stale", inflightTtlMs: 10 }); // expiresAt 10
    await t.mutation(api.example.begin, { key: "live", inflightTtlMs: 1000 }); // expiresAt 1000
    const removed = await t.mutation(api.example.purge, { before: 100, batch: 200 });
    expect(removed).toBe(1);
    expect(await t.query(api.example.get, { key: "stale" })).toBeNull();
    expect(await t.query(api.example.get, { key: "live" })).not.toBeNull();
  });

  test("purge with no cutoff defaults to server now and sweeps already-expired keys", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "old", inflightTtlMs: 1 }); // expiresAt 1
    vi.setSystemTime(1_000); // now past expiry
    const removed = await t.mutation(api.example.purge, {});
    expect(removed).toBe(1);
  });

  test("purge above the batch size self-reschedules and clears the whole tail", async () => {
    const t = setup();
    // mint 5 keys all expired at now=0 with a tiny lease
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.example.begin, { key: `b_${i}`, inflightTtlMs: 1 });
    }
    vi.setSystemTime(1_000);
    // batch=2 < 5 → first pass removes 2 and self-reschedules the rest
    const firstPass = await t.mutation(api.example.purge, { before: 1_000, batch: 2 });
    expect(firstPass).toBe(2);
    // drain the scheduled follow-up sweeps
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (let i = 0; i < 5; i++) {
      expect(await t.query(api.example.get, { key: `b_${i}` })).toBeNull();
    }
  });
});

describe("idempotency — built-in prune cron", () => {
  test("registers a daily self-rescheduling prune job with the default page size", () => {
    expect(PRUNE_INTERVAL).toEqual({ hours: 24 });
    expect(PRUNE_BATCH).toBe(200);
    // the module's cronJobs() registration ran at import — the job is present
    expect(Object.keys(crons.crons)).toContain("idempotency:prune");
    const job = crons.crons["idempotency:prune"];
    expect(job?.name).toBe("mutations:purge");
    expect(job?.args).toEqual([{ batch: 200 }]);
  });
});

describe("idempotency — scopes", () => {
  test("the same key in different scopes is independent", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "shared", scope: "a" });
    const r = await t.mutation(api.example.begin, { key: "shared", scope: "b" });
    expect(r).toEqual({ state: "fresh" });
    expect(
      (await t.query(api.example.get, { key: "shared", scope: "a" }))?.status,
    ).toBe("inflight");
    expect(await t.query(api.example.get, { key: "shared", scope: "c" })).toBeNull();
  });
});

describe("idempotency — client options (custom scope + ttl)", () => {
  test("tenant client uses its default scope and ttls", async () => {
    const t = setup();
    const r = await t.mutation(api.example.beginTenant, { key: "t_1" });
    expect(r).toEqual({ state: "fresh" });
    expect(
      (await t.query(api.example.getTenant, { key: "t_1" }))?.status,
    ).toBe("inflight");
    expect(await t.query(api.example.get, { key: "t_1" })).toBeNull();
    expect(await t.mutation(api.example.purgeTenant, {})).toBe(0);
  });
});

describe("idempotency — effect-once proof (side-effect ran exactly once)", () => {
  test("calling idempotentIncrement twice with the same key increments the counter exactly once", async () => {
    const t = setup();
    const first = await t.mutation(api.example.idempotentIncrement, {
      idemKey: "eo_1",
      counterName: "eo_counter",
    });
    expect(first.ran).toBe(true);
    expect(first.value).toBe(1);

    const second = await t.mutation(api.example.idempotentIncrement, {
      idemKey: "eo_1",
      counterName: "eo_counter",
    });
    expect(second.ran).toBe(false);

    const counter = await t.query(api.example.getCounter, {
      name: "eo_counter",
    });
    expect(counter).toBe(1);
  });
});

describe("idempotency — crash-recovery cycle (expire inflight, reclaim, re-execute)", () => {
  test("crash (no complete) → expire → reclaim fresh → complete → counter is 2 after two fresh claims", async () => {
    const t = setup();

    const first = await t.mutation(api.example.idempotentIncrement, {
      idemKey: "cr_1",
      counterName: "cr_counter",
      inflightTtlMs: 10,
    });
    expect(first.ran).toBe(true);
    expect(first.value).toBe(1);

    vi.setSystemTime(0);

    await t.mutation(api.example.begin, {
      key: "cr_crash",
      inflightTtlMs: 10,
    });

    vi.setSystemTime(100);

    const reclaim = await t.mutation(api.example.idempotentIncrement, {
      idemKey: "cr_crash",
      counterName: "cr_counter",
      inflightTtlMs: 10,
    });
    expect(reclaim.ran).toBe(true);
    expect(reclaim.value).toBe(2);

    const counter = await t.query(api.example.getCounter, {
      name: "cr_counter",
    });
    expect(counter).toBe(2);

    const replayAgain = await t.mutation(api.example.idempotentIncrement, {
      idemKey: "cr_crash",
      counterName: "cr_counter",
    });
    expect(replayAgain.ran).toBe(false);
    expect(await t.query(api.example.getCounter, { name: "cr_counter" })).toBe(
      2,
    );
  });
});

describe("idempotency — concurrent complete() race", () => {
  test("two workers completing the same inflight key yield exactly one recorded:true", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "race_complete" });
    const results = await Promise.all([
      t.mutation(api.example.complete, {
        key: "race_complete",
        result: "worker_a",
      }),
      t.mutation(api.example.complete, {
        key: "race_complete",
        result: "worker_b",
      }),
    ]);
    const recorded = results.filter((r) => r.recorded === true);
    const alreadyDone = results.filter(
      (r) => r.recorded === false && r.reason === "already_done",
    );
    expect(recorded).toHaveLength(1);
    expect(alreadyDone).toHaveLength(1);
  });
});

describe("idempotency — upsertOnMissing on an already_done key", () => {
  test("upsertOnMissing:true on an already_done key still returns already_done (no overwrite)", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "upsert_done" });
    await t.mutation(api.example.complete, {
      key: "upsert_done",
      result: "original",
    });
    const r = await t.mutation(api.example.complete, {
      key: "upsert_done",
      result: "overwrite_attempt",
      upsertOnMissing: true,
    });
    expect(r).toEqual({ recorded: false, reason: "already_done" });
    const state = await t.query(api.example.get, { key: "upsert_done" });
    expect(state?.result).toBe("original");
  });
});

describe("idempotency — expired done key receiving complete() returns already_done", () => {
  test("complete on an expired done key returns already_done, not expired (asymmetry)", async () => {
    const t = setup();
    await t.mutation(api.example.begin, {
      key: "exp_done_complete",
      inflightTtlMs: 100,
    });
    await t.mutation(api.example.complete, {
      key: "exp_done_complete",
      result: "saved",
      doneTtlMs: 10,
    });
    vi.setSystemTime(200);
    const r = await t.mutation(api.example.complete, {
      key: "exp_done_complete",
      result: "attempt2",
    });
    expect(r).toEqual({ recorded: false, reason: "already_done" });
  });
});

describe("idempotency — invalid TTL rejection (INVALID_TTL)", () => {
  test("inflightTtlMs:0 throws INVALID_TTL", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.begin, { key: "bad_ttl", inflightTtlMs: 0 }),
    ).rejects.toThrow();
  });

  test("inflightTtlMs:-1 throws INVALID_TTL", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.begin, { key: "neg_ttl", inflightTtlMs: -1 }),
    ).rejects.toThrow();
  });

  test("doneTtlMs:0 throws INVALID_TTL", async () => {
    const t = setup();
    await t.mutation(api.example.begin, { key: "bad_done_ttl" });
    await expect(
      t.mutation(api.example.complete, {
        key: "bad_done_ttl",
        doneTtlMs: 0,
      }),
    ).rejects.toThrow();
  });
});

describe("idempotency — purge edge cases", () => {
  test("purge on empty table returns 0", async () => {
    const t = setup();
    const removed = await t.mutation(api.example.purge, {
      before: 9_999_999,
      batch: 200,
    });
    expect(removed).toBe(0);
  });

  test("purge preserves a non-expired done key", async () => {
    const t = setup();
    await t.mutation(api.example.begin, {
      key: "live_done",
      inflightTtlMs: 100,
    });
    await t.mutation(api.example.complete, {
      key: "live_done",
      result: "keep",
      doneTtlMs: 100_000,
    });
    vi.setSystemTime(50);
    const removed = await t.mutation(api.example.purge, {
      before: 50,
      batch: 200,
    });
    expect(removed).toBe(0);
    const state = await t.query(api.example.get, { key: "live_done" });
    expect(state?.status).toBe("done");
    expect(state?.result).toBe("keep");
  });
});
