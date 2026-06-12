# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-12

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
