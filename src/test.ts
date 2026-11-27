/// <reference types="vite/client" />
import type { GenericSchema, SchemaDefinition } from "convex/server";
import type { TestConvex } from "convex-test";
import schema from "./component/schema.js";

const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register this component with a `convex-test` instance so consuming apps can
 * test integration: `import { register } from "@vllnt/convex-idempotency/test"`.
 *
 * @param t - A `convex-test` instance built from the host app's own schema.
 * @param name - The name the component is mounted under (default `"idempotency"`).
 */
export function register<TSchema extends GenericSchema>(
  t: TestConvex<SchemaDefinition<TSchema, boolean>>,
  name = "idempotency",
): void {
  t.registerComponent(name, schema, modules);
}
