# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-27

### Fixed

- `begin` and `complete` reject an empty `key` or `scope` with
  `ConvexError({ code: "INVALID_KEY" | "INVALID_SCOPE" })` instead of accepting it. In 0.1.0
  every call with an empty key or scope shared one row, so unrelated requests replayed each
  other's result. Calls that pass `""`, including `defaultScope: ""`, now throw.
- The optional fields of the constructor options and of the `begin`, `complete` and `purge`
  options accept an explicit `undefined`. Hosts that turn on `exactOptionalPropertyTypes` can pass
  `v.optional(...)` arguments straight through instead of getting TS2379. Types only widen, so
  every call that compiled against 0.1.0 still compiles.
- `register(t)` from `@vllnt/convex-idempotency/test` accepts a `convex-test` instance built
  from the host app's own schema. It was typed for the component's schema only, so a host schema
  with its own tables failed with TS2345. Types only; nothing changes at runtime.
- `@vllnt/convex-idempotency/test` and the component sources now use explicit `.js` relative
  imports and reference `vite/client`, so they type-check for consumers under both `bundler` and
  `nodenext` module resolution.

### Documentation

- Document the error codes in `docs/API.md` and how to use `/test` in a consuming app.
- The npm package now ships `docs/API.md`, `CHANGELOG.md` and `llms.txt`, so coding agents can
  read docs that match the installed version under `node_modules/@vllnt/convex-idempotency/`.
  `llms.txt` links the bundled files relatively and adds a "For coding agents" note and an
  ecosystem link; the README adds the same note and a "Related packages" section.
- `docs/API.md` lists the package entry points and notes that `get` returns an expired row until
  it is purged or re-minted, and that a future `purge` `before` cutoff also deletes live keys.
  TSDoc no longer suggests a `convex/values` `.parse` for `resultValidator` and lists the
  `superseded` completion reason. The package description says "lease-based" instead of
  "exactly-once", matching the README's side-effect caveat.

### Changed

- Releases run only from `.github/workflows/publish.yml` (npm trusted publishing with provenance,
  stable `@latest` from a `vX.Y.Z` tag on `main`); local publish scripts were removed.
- Move to pnpm 10 with a seven-day release-age gate, and add low-memory dev defaults.
- Canary builds publish on every push to `main` that changes the package or its shipped docs,
  under the `canary` dist-tag only; the repository-variable gate was removed.
- `pnpm test:package` (run in CI) fails when a required file is missing from the npm tarball, a
  contributor file would ship, or an `llms.txt` link does not resolve inside it. Test files and
  the privacy scan are checked by `scripts/check-package-contents.sh` before every publish.
- `package.json` `homepage` points to `https://oss.vllnt.com/packages/convex-idempotency`, with
  more keywords.
- Development dependencies upgraded: `convex` 1.51, `convex-test` 0.0.73, `eslint` 10,
  `@vllnt/typescript` 3 (stricter compiler checks, including `exactOptionalPropertyTypes`),
  `vitest` 5.1.1, pnpm 10.34.9, and the `minimatch` override to 11.0.9. The `convex` peer range
  stays `^1.45.0`.
- `begin` (on `done`) and `get` leave the `result` key out when no result is stored, instead of
  setting it to `undefined`. The value read is the same; only same-process checks such as
  `"result" in r` or `toStrictEqual` see the difference.
- Type tests (`*.test-d.ts`) now run with every `vitest run`, so CI type-checks the example app.
- The publish workflow runs `pnpm test:package` in its quality gates, so a canary or stable
  release no longer relies on PR CI for the tarball check.

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
