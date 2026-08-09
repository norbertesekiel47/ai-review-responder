# feat-729-generate-domain-module — deviations

Entries the plan did not anticipate. Each gets an orchestrator verdict
(ACCEPT / RE-PLAN) at step 6.

## D1 — surface overlap with feat-719-drip-dropped-column (setup, step 2)

`scripts/ci/tenant-scope-allowlist.ts` is in both worktrees' surfaces. Both
branches change the entry count, so both touch `ALLOWLIST_BASELINE` —
guaranteed conflict on whichever lands second.

**Agreed merge order:** #729 lands first (small, unblocked,
behaviour-preserving). feat-719 (gate-red, parked on its own audit blocker)
rebases onto main afterward and recomputes its baseline as part of resolving
its existing allowlist work. Mirror note written to feat-719's deviations
file. Owner can veto asynchronously.

VERDICT: ACCEPT (coordination note, no plan impact beyond merge order)

## D2 — surface-glob encoding artifact (T2, step 4)

`edit-surface-guard.sh` matches surfaces with bash `[[ == ]]` globs, so the
declared entry `src/app/api/dashboard/reviews/[reviewId]/generate/**` parsed
`[reviewId]` as a character class and could never match the route files the
intake explicitly budgets ("route -~120 lines"). Corrected in BOTH intake
copies to the escaped `src/app/api/dashboard/reviews/\[reviewId\]/generate/**`.
Classified as a **correction, not a counted amendment** — the surface's
meaning is unchanged; only its encoding for the matcher was wrong (the #643
lesson: don't burn the amendment budget on spelling).

**Correction (gate run 1):** the two enforcement layers DISAGREE on
`[...]` paths. The bash hook needs the escaped `\[reviewId\]` (else character
class); `scripts/ci/feature-surface-audit.ts` `globToRegExp` escapes every
literal char — so it needs the UNESCAPED spelling and reads `\[` as a literal
backslash. Its header claims its semantics match the hook's; for
character-class characters they do not. No single spelling satisfies both, so
the surface now declares BOTH spellings (each matcher is satisfied by one;
the other is inert under `.some()`). Tooling-defect lesson queued for
lab-notes promotion at step 8; fixing either matcher is out of surface and
out of scope here.

VERDICT: ACCEPT

## A1 — counted surface amendment: + src/lib/shared/response-status-sql.ts (T2)

The plan's claim that `TransactionSql` is assignable where `statusArraySql`
takes `Sql` is FALSE (postgres.js types them as sibling interfaces; typecheck
proves TS2345). The locked interface requires `statusArraySql(tx, …)`, so the
helper's parameter widens one line to accept the union — same shape as
`SubscriptionSql` in `src/lib/shared/writable-subscription.ts` (named
precedent), and the helper's own doc comment already promises "the caller's
`sql`/`tx` client". Added to BOTH intake copies. **Amendment count: 1 of 2**
(a second counted amendment triggers the abort criteria). Owner may veto
asynchronously.

VERDICT: ACCEPT

## D3 — route.test.ts txMock fragment pass-through (T2, queued by the T2 agent)

After T2, `statusArraySql` runs against the mocked tx inside route.test.ts;
its fragment-building tag call would consume a seeded rowset and desync the
queue. The suite gets a minimal mock-shape edit (recognize the `?::text[]`
fragment call, return it without consuming the queue — same shape as the T1
suite's txTag). Mock plumbing only; no behavioural assertion changes, so the
characterization eval stands.

VERDICT: ACCEPT (justified mock-plumbing edit, assertions untouched)
