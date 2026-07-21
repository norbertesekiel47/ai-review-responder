> **Correction (2026-07-20):** Migration numbers in this report are pre-renumber —
> `poller_cursors` shipped as **081**, not 079 (079/080 on `main` are agent-spine
> retention and scheduler dedup respectively). The `accounts(subscription_status, id)`
> composite index described here was **DROPPED before merge** per the staging
> EXPLAIN gate (commit `d93a62e8`) — it does not exist on `main`. See `TRIAGE.md`.
> Body below is a point-in-time record and is intentionally untouched.

# Standards & Maintainability Review — `feat/stripe-reconcile-remainders` (#479)

Reviewer: STANDARDS & MAINTAINABILITY agent (step 7, dual-axis review)
Diff reviewed: `git diff 96b4f28c HEAD` (fork = main HEAD `96b4f28c`)
Skill applied: `thermo-nuclear-code-quality-review` (baseline + non-negotiable standards), plus this repo's documented invariants.

## Scope of the change

Persists `StripeLocationsReconcilePoller`'s in-memory keyset resume cursor across
worker restarts (migration 079 `poller_cursors` + write-sequence CAS, ADR 0006),
adds a composite index for the accounts query (migration 080), and adds a
sustained-truncation alert. New modules:

- `billing-reconciliation/cursor-store.ts` — `loadCursor` / `saveCursor` (CAS UPSERT).
- `billing-reconciliation/reconcile-progress.ts` — pure `nextCursor` / `classifyCycle` / `evaluateTruncation`.
- `billing-reconciliation/truncation-alert.ts` — Sentry-or-log emitter (mirrors `drift-alert.ts`).
- `billing-reconciliation/constants.ts` — shared `LOG_PREFIX`, `POLLER_NAME`, timeouts, threshold.
- `StripeLocationsReconcilePoller.ts` — orchestrator grows +242 lines (now 535 total).

## Thermo-nuclear skill output

Applying the skill's baseline ("rethink the structure, be ambitious, look for
code-judo") and its non-negotiable standards:

**0. Ambitious structural simplification.** The persistence lifecycle
(boot-load → seed `writeSeq`/`accountCursor` → re-seed-on-failure → CAS save) is a
single cohesive concept but is spread across `beginCursorLoad`, four module-level
mutable vars (`accountCursor`, `writeSeq`, `writeSeqSeeded`, `cursorLoaded`),
`reconcileCycle`'s cursor read + in-cycle advance, and a ~70-line `runOnce.finally`.
A code-judo move exists — encapsulate the lifecycle in a small `CursorPersistence`
object owning `writeSeq`/`writeSeqSeeded`/`cursorLoaded` and exposing
`load()` / `current()` / `advance(cursor)` / `persist()`. That would delete four
module vars from the poller and pull the re-seed branch out of the finally. This is
a legitimate improvement but *arguable* (the state genuinely couples to
`reconcileCycle`'s cursor read) and the current code is heavily documented + tested,
so it is recorded in the low-confidence appendix, not as a blocking finding.

**1. 1k-line file rule.** The poller lands at 535 lines — well under 1000. No
file-size blocker. The four extracted modules are the right decomposition.

**2. Spaghetti / ad-hoc branching.** The new conditionals are NOT scattered into
unrelated flows — they are localized to the persistence lifecycle and the cycle
classification, which is exactly where they belong. `classifyCycle` /
`evaluateTruncation` are a clean pure state machine, not inline branches. The
`runOnce.finally` is dense (three concerns: truncation alert, re-seed, persist) but
each is internally guarded and the ordering is genuine temporal coupling, not
incidental. One concrete wart found in the re-seed branch (see F1 below).

**3. Clean the design vs. accept working code.** The design is deliberately clean;
the write-seq CAS is the correct scheme (ADR 0006 documents the four rejected
alternatives). No rubber-stamp concern.

**4. Direct/boring over magic.** No magic. `cursor-store.ts` is a deep module
hiding the CAS UPSERT + bigint coercion behind a two-function interface. No thin
pass-throughs. `truncation-alert.ts` faithfully mirrors the `drift-alert.ts`
precedent.

**5. Type/boundary cleanliness.** No `any` in production. `PollerCursorRow.write_seq`
is typed `number | string` and coerced via `Number(...)` — the correct Postgres.js
bigint-shape guard, not a cast. Test files use `any` for the `sql` fake (tests are
exempt per invariant #1 / repworth.md).

**6. Canonical layer / reuse.** Logic lives in the right layer. `emitTruncationAlert`
reuses the established Sentry-or-`createWorkerLogger` fallback pattern rather than a
bespoke sink. `constants.ts` gives the log prefix + poller name a single owner.

**7. Sequential orchestration / atomicity.** Fan-out is already bounded-parallel
(concurrency 3). The single serialized cursor persist in `finally` is correct — the
CAS makes concurrent/late saves safe. No avoidable orchestration complexity.

## Repo-standard checks (explicit)

| Standard | Verdict | Evidence |
|---|---|---|
| **Invariant #15** — domain modules take `sql`/`tx` param, never import `@/lib/db/server` | PASS | `cursor-store.ts` takes `sql: Sql` param; `reconcile-progress.ts` + `truncation-alert.ts` are IO-free/no DB. The poller imports the `sql` singleton **as a composition root** (registered in `worker/index.ts`) and passes it into `loadCursor`/`saveCursor` — exactly the invariant's allowance. |
| **Invariant #10** — Node native crypto, never crypto-js | PASS (N/A) | No crypto used anywhere in the diff. |
| **No `any`** (carve-out = PgBouncer JSONB guard only) | PASS | Zero `any` in production files. bigint coercion is a typed `number \| string` union + `Number()`, not `any`. Test `any` is exempt. |
| **Structured logging**, never log secrets/review text | PASS | All logging via `createWorkerLogger`. `truncation-alert.ts` logs poller name + counts + deadline only. No secrets/tokens/review text. |
| **Best-effort-after-primary needs own try/catch (log-and-swallow)** | PASS | `runOnce.finally`: truncation classify+alert wrapped in its own `try/catch` (L255-270); re-seed wrapped in `try/catch` (L292-308); `saveCursor` wrapped in `withTimeout(...).catch(...)` (L312-316). `inProgress = false` (L318) is reached on every path — no guarded block can throw past it, so the single-flight flag can never wedge. |
| **JSONB via `sql.json()`**, never `${JSON.stringify(x)}::jsonb` | PASS (N/A) | `poller_cursors` is simple columns (`cursor UUID`, `write_seq BIGINT`). `saveCursor` binds `${cursor}::uuid` — correct, no double-encode risk. |
| **Deep modules vs shallow** | PASS | `cursor-store` (hides CAS SQL + coercion), `reconcile-progress` (pure state machine), `truncation-alert` (hides sink selection) all hide real complexity behind semantic interfaces. No identity wrappers. |
| **Precedent adherence** | PASS | `truncation-alert.ts` matches `drift-alert.ts` structure (Sentry-when-DSN / structured-log fallback, `feature:stripe_reconciliation` tag, shared `LOG_PREFIX`). Cursor code follows the ZernioRecentReviewPoller keyset pattern (cited inline). |
| **Migration conventions** (CONCURRENTLY / IF NOT EXISTS / gates) | PASS | 079: `CREATE TABLE IF NOT EXISTS`, transactional (correct — brand-new table, no CONCURRENTLY needed), deny-all RLS, staging-first note. 080: `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, documents non-transactional apply, INVALID-index recovery, and a **mandatory ride-time EXPLAIN gate** for both cursor forms. migrations-log head advanced 078→080. Exemplary. |
| **Test quality** (meaningful vs over-mock) | PASS | Property tests for the CAS monotonicity invariant + the decisive detached-save race (the ADR 0006 regression), and for the truncation state machine (fire-once, stall/drain reset). Not trivia. See appendix A2 for one coverage gap tied to F1. |

## Findings

### F1 (LOW) — `runOnce.finally` re-seed reassigns `accountCursor`, clobbering the in-cycle advance on the failed-boot path

`StripeLocationsReconcilePoller.ts:299`. The FIX-1a re-seed block exists (per its own
comment, L280-285) **only to recover `writeSeq`** after a failed boot-load so the CAS
is not rejected. But it also executes `accountCursor = reseeded.cursor` (L299).

By the time this runs, `reconcileCycle` has already walked from the top (boot-load
failed → `accountCursor` was `null`) and advanced `accountCursor` to the last claimed
id (L465). The re-seed then overwrites that fresh advance with the **stale durable
cursor from a prior rotation**, and persists that stale value (seq+1). Consequences:

- The cycle's progress is discarded; the persisted + in-memory cursor jumps to the
  prior-rotation position.
- If the durable id sorts *after* the just-claimed head, the next cycle resumes past
  a slice of accounts, deferring their drift check by up to one extra rotation
  (~1 hour). This stays within the never-skip invariant (defer, never permanent skip),
  so it is **bounded and safe** — hence LOW severity — but it is unmotivated by the
  comment, surprising, and wastes the cycle's work.

Why it will bite: the reassignment is objectively not needed for the re-seed's stated
purpose, and it is **untested** for the colliding case (the only FIX-1a test,
`StripeLocationsReconcilePoller.test.ts:1727`, has the re-seed `loadCursor` return
`{ cursor: null, ... }` on a *drained/empty* cycle, so a non-null durable cursor
colliding with a non-empty in-cycle advance never runs). A future edit to persistence
that assumes "the finally persists the cursor the cycle advanced to" will be wrong on
this path. Fix: re-seed `writeSeq` only; leave `accountCursor` as the cycle set it.

## Low-confidence appendix (speculative "might be nicer" — NOT stakeable)

**A1. Encapsulate the cursor-persistence lifecycle.** Four module-level mutable vars
(`accountCursor`, `writeSeq`, `writeSeqSeeded`, `cursorLoaded`) plus `beginCursorLoad`
plus the finally re-seed/persist implement one concept — a durable, CAS-ordered,
lazily-loaded cursor. A `CursorPersistence` value object owning that state and
exposing `load()`/`current()`/`advance(id)`/`persist()` would remove four vars from
the poller, collapse the finally to `await persistence.persist()`, and make F1
structurally impossible (the object, not the finally, decides what to persist). Cost:
the object must still hand `reconcileCycle` the current cursor and receive the advance,
so the coupling does not fully disappear. Arguable; not blocking.

**A2. Add the missing re-seed collision test.** Complementary to F1: a test where
boot-load fails, the accounts query returns a **non-empty** batch that advances the
cursor, and the re-seed `loadCursor` returns a **non-null** durable cursor — asserting
which cursor is persisted. This is the one behavioral corner the current suite leaves
open, and writing it is what surfaces F1.

**A3. Test-seam surface.** The poller now exports five test-only functions
(`resetAccountCursorForTests`, `resetTruncationStateForTests`,
`simulateBootLoadedForTests`, `beginCursorLoadForTests`, plus `runOnce`/`reconcileCycle`).
That is a lot of module-internal state leaking into the public API for test control
(design.md: "don't let test convenience force leaky interfaces"). It matches the
existing poller pattern in this repo, so it is not a regression — but A1's
encapsulation would also shrink this surface (reset the object, not four globals).

**A4. Unconditional hourly UPSERT.** `saveCursor` runs every cycle even when the
cursor did not change (e.g. an empty drained rotation), bumping `write_seq` +
`updated_at`. One trivial UPSERT/hour — negligible, noted only for completeness.

## Verdict

Standards compliance is strong across every documented invariant, the migrations are
exemplary (esp. the 080 ride-time EXPLAIN gate), and the tests are genuinely
invariant-driven rather than trivia. One concrete low-severity defect (F1: the
finally re-seed clobbers the in-cycle cursor advance on the rare failed-boot path,
bounded by never-skip but unmotivated and untested). The larger structural note
(scattered persistence-lifecycle state) is a real but arguable improvement, recorded
in the appendix. No file-size, spaghetti, `any`, logging, or precedent violations.
