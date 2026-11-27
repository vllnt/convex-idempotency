import { defineComponent } from "convex/server";

/**
 * The idempotency component definition. Mount it in the host's
 * `convex/convex.config.ts` with `app.use(idempotency)`; its functions are then
 * reachable as `components.idempotency`. It owns one sandboxed table, `keys`,
 * and a daily cron that purges expired keys.
 */
const component = defineComponent("idempotency");

// Nest official child components here, e.g.:
// import sharded from "@convex-dev/sharded-counter/convex.config";
// component.use(sharded);

export default component;
