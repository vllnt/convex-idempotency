import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { expectTypeOf, test } from "vitest";
import { register } from "../../src/test";
import schema from "./schema";

/**
 * Type-level regression tests for `register(t)`: a consuming app passes a
 * `convex-test` instance built from its own schema, which has its own tables
 * and none of the component's.
 */
type RegisterTarget = Parameters<typeof register>[0];

test("register accepts the example app's schema", () => {
  const t = convexTest(schema, {});
  expectTypeOf(register).toBeCallableWith(t);
  expectTypeOf(register).toBeCallableWith(t, "second");
});

test("register accepts a host schema with unrelated tables and indexes", () => {
  const hostSchema = defineSchema({
    todos: defineTable({ text: v.string(), done: v.boolean() }).index(
      "by_done",
      ["done"],
    ),
  });
  const t = convexTest(hostSchema, {});
  expectTypeOf(register).toBeCallableWith(t);
});

test("register accepts loose table names and an explicitly typed instance", () => {
  const loose = defineSchema(
    { notes: defineTable({ body: v.string() }) },
    { strictTableNameTypes: false },
  );
  expectTypeOf(register).toBeCallableWith(convexTest(loose, {}));
  expectTypeOf<TestConvex<typeof schema>>().toExtend<RegisterTarget>();
  expectTypeOf<TestConvex<typeof loose>>().toExtend<RegisterTarget>();
});

test("register rejects values that are not a convex-test instance", () => {
  expectTypeOf<RegisterTarget>().not.toBeAny();
  expectTypeOf<string>().not.toExtend<RegisterTarget>();
  expectTypeOf<
    ReturnType<TestConvex<typeof schema>["withIdentity"]>
  >().not.toExtend<RegisterTarget>();
});
