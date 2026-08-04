# T1b spec review — commit `de937391`

**Ticket:** RepWorth #644 — Unsubscribe / opt-out
**Task:** T1b — `findRedeemableUnsubscribeToken` + `redeemUnsubscribeToken`
**Reviewed:** `de937391` against its parent `3d649f8f`
**Verdict:** ✅ **Spec compliant**

Everything below was verified by reading the committed code and by running it —
not from the implementer's report.

---

## 1. Scope of the diff

```
scripts/ci/tenant-scope-allowlist.ts                             |  37 +-
src/lib/solicitation/__tests__/unsubscribe.integration.test.ts   | 669 ++++++++
src/lib/solicitation/__tests__/unsubscribe.test.ts               |  33 +
src/lib/solicitation/unsubscribe.ts                              | 188 ++++
4 files changed, 926 insertions(+), 1 deletion(-)
```

All four are inside the permitted surface
(`src/lib/solicitation/unsubscribe.ts`, `src/lib/solicitation/__tests__/**`,
`scripts/ci/tenant-scope-allowlist.ts`). **Nothing was touched outside it.**
No migration, no route, no worker, no doc churn.

---

## 2. Requirement-by-requirement

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Signature `findRedeemableUnsubscribeToken(db: SqlExecutor, rawToken)` → `{businessName} \| null` | ✅ | `unsubscribe.ts:157-179`; `type SqlExecutor = Sql \| TransactionSql` at `:121` |
| 2 | Signature `redeemUnsubscribeToken(tx: TransactionSql, {rawToken, source})` → status + `tokenHashPrefix` | ✅ | `:196-282`. Return is a 4-arm discriminated union, structurally identical to the requested shape and strictly stronger |
| 3 | Claim UPDATE is the first and only write-ordering primitive, `RETURNING account_id, business_id, normalized_handle, channel` | ✅ | `:210-215` — byte-for-byte the specified statement |
| 4 | `recordSuppression` receives the **RETURNED** values | ✅ | `:221-227` — `claimed.channel / claimed.normalized_handle / claimed.account_id`. No pre-claim read exists in the function to accidentally use |
| 5 | No-row branch disambiguates on `redeemed_at`, never bare existence | ✅ | `:250-259`, and **mutation-proven** (§4 below) |
| 6 | `redeemed_at IS NULL` on the follow-up read → `unknown_token` | ✅ | `:257` |
| 7 | No row at all → `unknown_token` | ✅ | same guard, `existing === undefined` |
| 8 | Spent branch → ledger, **no write** | ✅ | `:268-281` is a single `SELECT EXISTS`. There is no `INSERT`/`UPDATE` after the claim on this path |
| 9 | Ledger consulted for `scope='global'` **only** | ✅ | `:273`, and **mutation-proven** (§4) |
| 10 | Outcome table (won→`redeemed`; lost+spent+global→`already_suppressed`; lost+spent+no global→`already_redeemed_not_suppressed`; lost+unspent→`unknown_token`; no row→`unknown_token`) | ✅ | All five rows have a dedicated live-DB test; all pass |
| 11 | Both functions call `isWellFormedUnsubscribeToken` FIRST with zero DB work | ✅ | `:163` and `:200`. Proven by the throw-on-any-access `Proxy` executor in the unit suite (`unsubscribe.test.ts:92-121`) — the Proxy traps **`get` as well as `apply`**, so even a property read fails the test |
| 12 | `recordSuppression` reused verbatim, machine-authored variant | ✅ | imported at `:4-9`, never re-implemented. Called with `{scope:'global', channel, normalizedHandle, accountId, source}` — no `createdByUserId`, no `note`, which the union in `suppression.ts` types as `?: never` |
| 13 | `recordSuppression`'s `null` return does **not** gate the stamp | ✅ | `:228-242` — the return value is discarded entirely; `redeemed` is unconditional once the claim wins. Covered by `stamps redeemed_at even when an existing suppression row wins first-write-wins` |
| 14 | Cross-account fail-closed `businessName` | ✅ | `:169-172` — `LEFT JOIN businesses b ON b.id = t.business_id AND b.account_id = t.account_id`. A purge-scrubbed token has `account_id IS NULL`, so `NULL = NULL` is UNKNOWN and the join cannot match → generic copy |
| 15 | Invariant #15 — explicit executor, never imports `@/lib/db/server` | ✅ | `pnpm ci:db-imports` → *passed (strict)*. The only mention of the module in the file is a comment at `:119` |
| 16 | Allowlist entries under `pre-auth-token` + baseline bump | ✅ | 5 entries, `ALLOWLIST_BASELINE` 411 → 416. `pnpm ci:tenant-scope` → *passed — entries: 416 (baseline: 416)* |
| 17 | 16 verbatim test titles | ✅ | All 16 matched character-for-character by a literal-string grep (`rg -F "it('<title>'"`). 15 in the integration suite, 1 (`a forged token is rejected without opening a database connection`) in the unit suite, exactly as the spec implies |
| 18 | Live-DB conventions | ✅ | File is `src/lib/solicitation/__tests__/unsubscribe.integration.test.ts`; no migration SQL at run time; `assertSchemaReady(db, [MIGRATION_096_SOLICITATION_SUPPRESSIONS])` at `:259`; `afterEach` sweeps by `normalized_handle` at `:284-297`; holds `acquireLiveDbLock`. `pnpm ci:live-db-suites` → *passed* |

### Nothing requested is missing. Nothing unrequested was built.

Three small additions beyond the literal ask, all defensible and none
speculative:

* `UnsubscribeRedemptionSource` is **derived** (`Extract<SuppressionSource, …>`)
  rather than re-spelled — one owner for the source vocabulary.
* `toSuppressionChannel` (`:288-294`) narrows the token table's `channel` CHECK
  into the ledger's `SuppressionChannel` and throws on drift. It runs *inside*
  the transaction after the claim, so a drift throw rolls the claim back rather
  than stamping a token it could not suppress. Correct failure semantics.
* One extra integration test — `resolves nothing for an unknown token or one
  already redeemed` — covering §5.4's enumeration rule for the read path.

---

## 3. Banned-pattern sweep

| Check | Result |
|---|---|
| `any` / `as any` | None. (`rg ': any\b\|as any'` → the only hit is the word "any" in prose) |
| `${JSON.stringify(x)}::jsonb` | None — the module writes no JSONB |
| Raw handle or raw token in a log line | None — **the module logs nothing at all.** It returns a 12-char `tokenHashPrefix` and leaves logging to the caller, which is the stricter posture (invariant #5) |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |

---

## 4. Claim C — mutations re-run independently

Both mutations were applied by me, run, and reverted. `git status` is clean and
`git diff HEAD --stat` is empty.

### Mutation (i) — bare existence check

`:257` `if (existing === undefined || existing.redeemed_at === null)` →
`if (existing === undefined)`.

```
× a token minted after the claim snapshot reports unknown rather than already suppressed
  → AssertionError: expected 'already_redeemed_not_suppressed' to be 'unknown_token'
Tests  1 failed | 15 passed (16)
```

Exactly one test reddens, and it is the named one. **The observed value is
load-bearing evidence in its own right:** `already_redeemed_not_suppressed` can
only be produced if the follow-up `SELECT` *found the row*, i.e. the concurrently
minted token was genuinely visible to the follow-up statement's fresh Read
Committed snapshot. That is precisely the interleaving the test claims to
reproduce, confirmed from the outside.

### Mutation (ii) — drop `AND scope = 'global'`

`:273` removed.

```
× an account scoped suppression alone does not justify the global success sentence
  → AssertionError: expected 'already_suppressed' to be 'already_redeemed_not_suppressed'
Tests  1 failed | 15 passed (16)
```

Exactly one test reddens, and it is the named one.

Post-revert confirmation: `pnpm vitest run unsubscribe.test.ts
unsubscribe.integration.test.ts` → **26 passed (26)**, `git status --porcelain`
empty.

---

## 5. Claim A — are the concurrency tests real?

**Yes.** Three independent lines of evidence.

**(a) The gate throws.** `waitForTokenRowLockWaiter` (`:194-210`) polls
`pg_stat_activity` for `wait_event_type = 'Lock'` on a query touching
`solicitation_unsubscribe_tokens`, and after 15 s
`throw new Error('no backend ever blocked on the unsubscribe token row lock')`.
There is no `return` on the timeout path. A run in which contention never
happens **cannot** reach the assertions.

**(b) I proved the gate is not vacuously satisfied.** I mutated the probe's
`ILIKE '%solicitation_unsubscribe_tokens%'` to `'%zzz_no_such_table_zzz%'` and
ran the suite:

```
× two overlapping redemptions write exactly one ledger row and one redeemed_at  75040ms
  → no backend ever blocked on the unsubscribe token row lock
```

So the probe is matching the *actual* blocked backend, not some always-present
unrelated one. (Reverted.)

**(c) Each concurrent test carries a second, independent overlap proof**, so it
would fail even if the probe were removed:

* `two overlapping redemptions …` asserts `order === ['first','second']`.
  `firstMayCommit` is only resolved *after* the wait, so if the second
  transaction were not parked it would settle first and the ordering assertion
  fails. It further asserts `redeemed_at` equals the stamp read *inside* the
  first transaction (`::text`, so postgres.js µs truncation cannot mask a
  re-stamp) and `countGlobalRows === 1`.
* `a concurrent purge …` asserts the ledger row's `account_id IS NULL`. If the
  redemption had not parked behind the purge's row lock it would have claimed
  the pre-scrub row version and written a non-null `account_id`. The assertion
  *is* the overlap proof.

**Could any pass if the code serialized everything?** No — serialization is what
they assert *happens*, and the contended path is what produces the asserted
values.

**Residual nit (Low).** When the wait *does* throw, `firstMayCommit` /
`purgeMayCommit` are never resolved, so the parked transaction stays open, the
blocked one waits forever, and `afterEach`'s `DELETE … WHERE normalized_handle
IN …` blocks behind the same row lock. I observed the file wedge for >280 s
instead of failing in 15 s. A `try { await waitFor… } finally {
firstMayCommit.resolve() }` would turn a CI timeout into a one-line failure.
Not a correctness defect in the code under review.

---

## 6. Claim B — the `commitBetweenStatements` Proxy

**Assessment: legitimate deterministic reproduction, not a fake.**

What the Proxy does (`:223-245`): it traps `apply` on the transaction tag,
counts statements, and on statement **1 only** awaits the real query, then awaits
`commitConcurrently()`, then returns the real rows. `commitConcurrently` is
`seedToken(...)`, which runs a genuine `INSERT` **on a different pooled
connection** and commits it.

Why that is not faking the thing under test:

1. **The subject code is unmodified.** `redeemUnsubscribeToken` runs its real
   claim `UPDATE`, its real follow-up `SELECT`, and its real branch. The Proxy
   injects no rows, rewrites no results, and changes no return value — it only
   controls *when* an independent committed transaction lands.
2. **The concurrency is real.** A second connection, a real committed `INSERT`,
   observed across the transaction boundary. The only synthetic element is
   determinism of the interleaving — and the window (between two statements of
   one transaction) is genuinely un-hittable by wall-clock racing, so
   choreographing it is the *correct* technique, not a shortcut.
3. **The interleaving is one production can produce.** #630's minter commits
   tokens continuously while the ingress redeems them. "Claim `UPDATE` misses,
   mint commits, follow-up read re-snapshots" is an ordinary Read Committed
   outcome, not a contrivance.
4. **The implementer's retry argument holds, but is the weaker proof.**
   `retry.status === 'redeemed'` shows the mint eventually committed — but it
   would also hold if the mint had landed *after* the whole function returned,
   in which case the test would pass through the `existing === undefined` arm
   and prove nothing about the branch. **Mutation (i) is the argument that
   actually closes this**: under a bare existence check the test reports
   `already_redeemed_not_suppressed`, which is only reachable when the follow-up
   `SELECT` *found the row*. That pins the mint to the intended window. So the
   test is sound, and the mutation — not the retry — is what demonstrates it.

One structural caveat worth recording: the Proxy keys on "statement 1", which
silently couples the test to `redeemUnsubscribeToken` issuing the claim first. A
future refactor adding a statement ahead of the claim would move the injection
point without failing loudly. Cheap hardening would be asserting the intercepted
query text. Not a defect today — the claim-first ordering the counter assumes is
itself the invariant under test.

---

## 7. Claim D — the suite genuinely ran

```
pnpm vitest run src/lib/solicitation/__tests__/unsubscribe.integration.test.ts
 ✓ ×16   Test Files 1 passed (1)   Tests 16 passed (16)   Duration 569ms
```

Sixteen `✓`, zero skips, all under the `|integration|` project (vitest's
serialized project — confirming the `*.integration.test.ts` glob took effect).
`describeWithDb` registers `describe.skip` and warns on stderr when the DB is
absent; no such warning appeared. This is not the #520 self-skip class.

---

## 8. Claim E — the fast-check property

`any sequence of redemptions over one token yields exactly one success-shaped
outcome` (`:421-447`) is a genuine property, not an example test in costume:

* Generator: `fc.array(fc.constantFrom('unsubscribe_one_click',
  'unsubscribe_link'), { minLength: 1, maxLength: 5 })` — arbitrary length and
  arbitrary source ordering, `numRuns: 10`.
* Invariant: exactly one `redeemed` in the whole sequence, it is the first, and
  exactly one global ledger row exists afterwards. That is the real
  at-most-once-suppression invariant, not a restatement of the implementation.
* Each run re-seeds a fresh token and handle, and every handle is registered for
  the `afterEach` sweep, so runs cannot contaminate one another.

**Honest limitation:** outcomes do not actually depend on which source is drawn,
so the only dimension with real discriminating power is sequence *length* — in
practice this is ~5 example tests with a shared oracle. It is a correct and
useful property, just a low-entropy one. Interleaving concurrency into the
generated sequence (or generating a Correction-path removal at a random index)
would raise its power. Not a spec violation; the requested title and the
requested shape are both satisfied.

---

## 9. Tenant-scope allowlist reasons — accuracy audit

All five sit under the pre-existing `pre-auth-token` category, which has no
`CATEGORY_PATH_RULES` entry, so `src/lib/solicitation/` needs no prefix waiver.

| Entry | Statement | Reason accurate? |
|---|---|---|
| 1 | tokens read for the landing page | ✅ The token really is the only credential; `isWellFormedUnsubscribeToken` really does gate it first (`:163`) |
| 2 | `businesses` in the same join | ✅ Describes it as the cross-account fail-closed guard, which matches `AND b.account_id = t.account_id` exactly |
| 3 | claim `UPDATE` | ✅ "the account_id it would be scoped by is what this statement RETURNS" — literally true; and the purge→NULL argument matches migration 096's `provenance_scrub_implication` CHECK |
| 4 | disambiguating `SELECT` | ✅ "reads no provenance — only redeemed_at plus the redemption target" — the projection is `redeemed_at, normalized_handle, channel`; no `account_id`/`business_id`/`ask_id`. Accurate |
| 5 | ledger `EXISTS` | ✅ The strongest of the five: correctly explains why this is deliberately *narrower* than `suppressionMatchSql`, and why an account filter would be meaningless on a `scope='global'` row keyed by `(channel, normalized_handle)` |

The `sqlSnippet` fields are byte-identical to source — `ci:tenant-scope` verifies
this and passed.

---

## 10. Observations (non-blocking, no action required for T1b)

1. **Test wedge on contention-detector failure** (Low) — §5 above. A
   `try/finally` around the two `waitForTokenRowLockWaiter()` calls that always
   releases the parked transaction would convert a multi-minute CI hang into a
   clean 15 s failure.
2. **`Proxy` statement counter is positional** (Low) — §6 caveat. Asserting the
   intercepted query text would make the coupling explicit.
3. **Unbounded hash on the malformed path** (Informational) —
   `redeemUnsubscribeToken` computes `hashUnsubscribeToken(input.rawToken)` over
   the *full* input at `:203`, while `isWellFormedUnsubscribeToken` deliberately
   caps work at `MAX_SIGNED_INPUT_LENGTH = 128`. A 1 MB body would be SHA-256'd
   before being rejected. Cost is ~milliseconds and the route will bound the body
   anyway, but it slightly undercuts the file's own "one HMAC compare" cost
   story. Hashing `rawToken.slice(0, MAX_SIGNED_INPUT_LENGTH)` — or returning a
   constant prefix for the malformed case — would restore it.
4. **`type SqlExecutor` is declared twice** (Informational) — identically in
   `suppression.ts:22` and `unsubscribe.ts:121`. This mirrors the existing local
   convention in this directory rather than introducing drift, so leaving it is
   defensible; worth one shared export if a third module needs it.
5. **Property-test entropy** (Informational) — §8.
6. **Reviewer-caused test-DB residue.** My two deliberately-wedged probe runs
   left 2 `businesses` rows (`Unsubscribe Fixture Diner`, `Unsubscribe Neighbour
   Cafe`) and 4 `accounts` rows (`Unsubscribe Fixture*`) in the local test
   database, because `afterAll` never completed. No `solicitation_unsubscribe_tokens`
   or `solicitation_suppressions` rows remain (both tables verified at 0). The
   suite generates fresh UUIDs per run and does not collide with them, so this is
   cosmetic; my cleanup `DELETE` was blocked by the permission classifier. Clean
   up with, against `TEST_DATABASE_POOL_URL`:
   ```sql
   BEGIN; SET CONSTRAINTS ALL DEFERRED;
   DELETE FROM businesses WHERE name IN ('Unsubscribe Fixture Diner','Unsubscribe Neighbour Cafe');
   DELETE FROM users    WHERE account_id IN (SELECT id FROM accounts WHERE display_name LIKE 'Unsubscribe Fixture%');
   DELETE FROM accounts WHERE display_name LIKE 'Unsubscribe Fixture%';
   COMMIT;
   ```

---

## 11. Commands run

```
git show --stat de937391
pnpm typecheck                                          → clean
pnpm lint                                               → clean
pnpm ci:tenant-scope                                    → passed — entries: 416 (baseline: 416)
pnpm ci:db-imports                                      → passed (strict)
pnpm ci:live-db-suites                                  → passed
pnpm vitest run …/unsubscribe.integration.test.ts       → 16 passed (16)
  + mutation (i) bare existence                         → 1 failed (the named test) | 15 passed
  + mutation (ii) drop scope='global'                   → 1 failed (the named test) | 15 passed
  + probe: ILIKE → impossible table                     → "no backend ever blocked …"
pnpm vitest run …/unsubscribe.test.ts …/unsubscribe.integration.test.ts → 26 passed (26)
git status --porcelain                                  → empty
```
