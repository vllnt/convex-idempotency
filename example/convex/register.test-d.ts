import { convexTest } from "convex-test";
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

test("register accepts a schema built without schema validation", () => {
  const t = convexTest(
    defineSchema(
      { notes: defineTable({ body: v.string() }) },
      { schemaValidation: false },
    ),
    {},
  );
  expectTypeOf(register).toBeCallableWith(t);
});

test("register still rejects a value that is not a convex-test instance", () => {
  expectTypeOf(register).parameter(0).not.toEqualTypeOf<string>();
});
