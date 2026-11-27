import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { expectTypeOf, test } from "vitest";
import { Idempotency } from "../../src/client/index";
import type { IdempotencyOptions } from "../../src/client/index";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";

/**
 * Type-level regression tests: hosts forward optional Convex args
 * (`v.optional(...)`, typed `T | undefined`) straight into the client options.
 * This must compile with `exactOptionalPropertyTypes` on, which this repo's
 * TypeScript preset enables.
 */
declare const maybeString: string | undefined;
declare const maybeNumber: number | undefined;
declare const maybeBoolean: boolean | undefined;
declare const mutationCtx: GenericMutationCtx<DataModel>;
declare const queryCtx: GenericQueryCtx<DataModel>;

const idem = new Idempotency<{ id: string }>(components.idempotency);

test("constructor options accept explicit undefined", () => {
  expectTypeOf<{
    defaultScope: string | undefined;
    defaultInflightTtlMs: number | undefined;
    defaultDoneTtlMs: number | undefined;
    upsertOnMissing: boolean | undefined;
    resultValidator: undefined;
  }>().toExtend<IdempotencyOptions<{ id: string }>>();
});

test("begin options accept explicit undefined", () => {
  expectTypeOf(idem.begin).toBeCallableWith(mutationCtx, "k", {
    scope: maybeString,
    inflightTtlMs: maybeNumber,
  });
});

test("complete options accept explicit undefined", () => {
  expectTypeOf(idem.complete).toBeCallableWith(mutationCtx, "k", undefined, {
    scope: maybeString,
    claimId: maybeString,
    doneTtlMs: maybeNumber,
    upsertOnMissing: maybeBoolean,
  });
});

test("get and purge accept explicit undefined", () => {
  expectTypeOf(idem.get).toBeCallableWith(queryCtx, "k", maybeString);
  expectTypeOf(idem.purge).toBeCallableWith(mutationCtx, {
    before: maybeNumber,
    batch: maybeNumber,
  });
});

test("options still reject values of the wrong type", () => {
  expectTypeOf<{ scope: number }>().not.toExtend<
    NonNullable<Parameters<typeof idem.begin>[2]>
  >();
});
