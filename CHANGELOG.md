# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-28

### Added

- The npm package ships `docs/API.md`, `CHANGELOG.md` and `llms.txt`, so coding agents can read
  docs that match the installed version under `node_modules/@vllnt/convex-idempotency/`. The
  README is rewritten for coding agents (when to use, every export, errors and fixes, limits,
  compatibility), and `docs/API.md` documents the entry points, client options, error codes and
  the built-in `idempotency:prune` cron (every 24 h, `batch` 200).

### Changed

- `begin` and `complete` throw `ConvexError({ code: "INVALID_KEY" })` ("key must not be empty")
  for an empty `key`. In 0.1.0 and its canaries, all calls with an empty key in the same scope
  shared one row, so unrelated requests replayed each other's result. The key and scope are
  checked before the TTL, so a call with both an empty key and a bad TTL now throws `INVALID_KEY`.
  What to do: pass a non-empty key, such as the request ID.
- `begin` and `complete` throw `ConvexError({ code: "INVALID_SCOPE" })` ("scope must not be
  empty") for an empty `scope`, including from a client built with `defaultScope: ""`. An empty
  scope did not collide in 0.1.0 and its canaries. What to do: pass a non-empty `scope` and
  `defaultScope`. Keys stored under the empty scope are not found under the new one, so a retry
  within their old TTL can run the work again (they stay readable with `get` until `purge`
  deletes them after they expire). `get` still accepts an empty key or scope.
- `begin` (on `done`) and `get` leave the `result` key out when no result is stored, instead of
  setting it to `undefined`. The value read is the same. What to do: check
  `r.result !== undefined`, not `"result" in r`.
- `engines.node` is `>=20` (was `>=18`), because the lowest `convex` peer, 1.45, needs Node 20
  (1.49 and up need Node 22). What to do: run Node 20 or later. The `convex` peer range is
  unchanged (`^1.45.0`).
- `@vllnt/convex-idempotency/test` now references the Vite types (`vite/client`). What to do:
  install `vite` (Vitest brings it) as a dev dependency next to `convex-test`; current
  `convex-test` versions need `convex@^1.46.0`.
- Releases publish only from `.github/workflows/publish.yml` with npm trusted publishing and
  provenance: stable `@latest` from a `vX.Y.Z` tag on `main`, and a canary under the `canary`
  dist-tag on pushes to `main` that change the package or its shipped docs. The local `release`, `alpha` and `prepublishOnly`
  scripts were removed.
- The package description no longer says "exactly-once", `homepage` points to
  `https://oss.vllnt.com/packages/convex-idempotency`, and there are more keywords.
- Internal: pnpm 10, dev-dependency upgrades, more tests and new CI package checks; no runtime
  change.

### Fixed

- An empty `key` no longer makes unrelated requests in one scope share a row; it is rejected (see
  Changed).
- The optional fields of the constructor options and of the `begin`, `complete` and `purge`
  options accept an explicit `undefined`. Hosts that turn on `exactOptionalPropertyTypes` can pass
  `v.optional(...)` arguments straight through instead of getting TS2379. Types only widen, so
  every call that compiled against 0.1.0 still compiles.
- `register(t)` from `@vllnt/convex-idempotency/test` is generic over the host schema, so it
  accepts a `convex-test` instance built from the host app's own schema. It was typed for the
  component's schema only, so a host schema with its own tables failed with TS2345. Types only.
- `@vllnt/convex-idempotency/test` and the component sources use explicit `.js` relative imports,
  so they type-check for consumers under both `bundler` and `nodenext` module resolution.
- TSDoc no longer suggests a `convex/values` `.parse` for `resultValidator` (those validators have
  none), and lists the `superseded` completion reason.
- CHANGELOG: the 0.1.0 entry has its real release date (2026-09-01) and lists the claim-ID fencing
  and purge-input checks that shipped in it; they were left under Unreleased.

### Security

- The 0.1.0 `purge` TSDoc said a caller cannot pass a future cutoff. That was wrong: an explicit
  `before` is used as given, and a future value also deletes live keys, so their work can run
  again. The TSDoc and docs now say so. Omit `before` or compute it on the server; never take it
  from client input. No runtime change.

## [0.1.0] - 2026-09-01

### Added

- First release of `@vllnt/convex-idempotency`.
- Server-sourced time: `begin`/`complete`/`purge` read `Date.now()` inside each
  handler — no caller-supplied `now` — so a hostile clock cannot force a key to
  look live or expired.
- Optional host `resultValidator` on the client, narrowing the opaque stored
  `result` to `TResult` at the boundary on `complete` (write), `begin`/`get`
  (read). Removes the previous unchecked `as TResult` cast.
- Split TTLs: a short inflight lease (`inflightTtlMs`, default 60s) so a crashed
  worker's claim self-heals fast, and a longer done grace (`doneTtlMs`, default
  24h). `begin` returns `expiresAt`/`retryAfterMs` on the `inflight` branch.
- `complete` now returns a discriminated `{ recorded: true } | { recorded: false,
  reason: "missing" | "expired" | "already_done" }`, plus an `upsertOnMissing`
  option to record finished work whose inflight row had vanished.
- Expired keys are re-minted in place (`db.patch`, reusing the row id) instead of
  delete-and-insert.
- Bounded, self-rescheduling `purge` (`take(batch)` + scheduler) and a built-in
  daily prune cron (`crons.ts`); idempotent.

### Fixed

- `begin` and `complete` now reject a TTL argument that is ≤ 0 or non-finite with
  `ConvexError({ code: "INVALID_TTL" })`. A zero or negative `inflightTtlMs` would
  have produced `expiresAt ≤ now`, immediately expiring the key on creation and
  breaking the dedup claim window. Same guard added for `doneTtlMs` in `complete`.

### Documented

- Expiry check order asymmetry between `begin` and `complete` is now documented in
  TSDoc on both mutations. `begin` checks expiry before the done-state (an expired
  done key re-mints fresh — the grace window elapsed, the operation may re-run).
  `complete` checks the done-state before expiry (an expired done key returns
  `already_done` — a prior winner's recorded outcome must not be overwritten).

### Fixed (since the first canary)

- Fence re-minted leases with opaque claim IDs so a stale worker cannot overwrite the newer
  claim's result, including when lost-claim upsert is enabled.
- Reject invalid purge batches and non-finite cutoffs before they can create scheduler loops or
  oversized transactions.

### Changed (since the first canary)

- Treat Convex `_generated` output as CLI-owned, exclude it from formatting, and expose a
  dedicated codegen script.
- Require `convex@^1.45.0`.
