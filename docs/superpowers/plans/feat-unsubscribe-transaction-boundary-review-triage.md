# #652 branch review triage — round 1

Fixed base: `fd0b48f342c573741ba4fd79633756b8348ee647`  
Gate fingerprint reviewed: `3cba7332939b2ea16b47d8e74cde41c8c3ddde14bc903b7a99a99ade5b8dcdb0`

| Finding | Verdict | Evidence and resolution |
| --- | --- | --- |
| Commit-before-response evidence was missing | ACCEPT | The ingress mock had stopped exercising the injected client's `begin`, and the live overlap test observed only final order. Restore a `redeem → commit → reply` assertion, prove same-token HTTP responses stay pending, and prove the live redemption promise stays pending while its internal transaction is parked before commit. |
| Promised valid-token transaction ownership was title-only | ACCEPT | The unit test proved forged tokens avoid DB access but not that a valid token opens exactly one module-owned transaction. Add a valid-token `begin` spy assertion while retaining the zero-access forged path. |
| Durable plan described the pre-#651 merge order | ACCEPT | Update the base, `.tsx` path, and coordination record: #651 landed first; #652 preserves and injects `sqlUnsubscribe` into the new transaction-owning interface. |

The independent database/transaction-risk reviewer reported no actionable
finding at or above 80% confidence.

# #652 branch review triage — round 2 (independent validation pass)

An independent validation pass re-ran the whole gate against the round-1 tree and
added one proof the earlier rounds did not carry: a temporary file that passes a
`TransactionSql` into `redeemUnsubscribeToken` now fails `tsc` with
`TS2345`, because postgres.js declares `begin` on `Sql` and not on
`TransactionSql`. The issue's goal — make the wrong isolation level
unrepresentable — is therefore compiler-enforced, not prose-enforced.

Six findings followed. None changed behavior.

| Finding | Verdict | Resolution |
| --- | --- | --- |
| `docs/currents.md` and `docs/progresstracking.md` still described #651 and #652 as open, filed follow-ups | ACCEPT | Both sentences now record that the two have landed. #651 merged without this sweep, so its record was corrected in the same edit. Required widening `allowed_edit_surface` by two doc paths, with user sign-off. |
| The `directory.md` adapter rows carried no `#652` provenance | ACCEPT | Both adapter rows now state that the adapter opens no transaction and injects its client into the module-owned one. |
| Deleting the `mockUnsubscribeBegin` call-count assertions left pool identity proved on the FIRST request only | ACCEPT | New `redeemClients()` seam asserts the injected client on every redemption in the repeat-POST, single-flight and three-token races. `expect(mockSharedBegin).not.toHaveBeenCalled()` cannot carry that evidence with the core stubbed — no `begin` runs at all — so it was never the guard it looked like. |
| The live overlap probe used `await Promise.resolve()`, a one-microtask drain, to call a promise pending | ACCEPT | Added the same `drainMicrotasks()` (`setImmediate`) the ingress suite uses, plus a comment stating what the pending promise proves. |
| `redeem:` wrapped a promise-returning call in a redundant `async` | ACCEPT | Removed. |
| Indentation drift in the three edited suites; one inline `Proxy` duplicated `sqlWithBeforeCommit` | ACCEPT | Re-indented. Both race probes now share one `sqlWithInterposedTransaction` helper. The landing fake's client type became a named alias instead of a 150-column inline annotation. There is no Prettier check in this repo — `lint` is `eslint .` — so nothing gated this. |

Behavior, outcomes, HTTP mappings and the claim-first algorithm are untouched by
round 2. The full gate was re-run after the fixes.

## Round 2, finding 7 — surfaced only after the commit existed

`pnpm ci:feature-surface` passed for the whole branch and then failed the moment
the implementation was committed, rejecting `src/app/api/u/[token]/route.ts`. It
compares the **committed** diff against the intake, so while the only commit was
the intake audit there was nothing to reject. This would have failed the PR's
`lint` job.

The cause was the intake's spelling of that one path, `src/app/api/u/[[]token[]]/route.ts`
— a bash character-class escape for a literal `[`. Measured against both
matchers, that spelling matches **neither**:

| Spelling | `edit-surface-guard.sh` | `ci:feature-surface` |
| --- | --- | --- |
| `src/app/api/u/[[]token[]]/route.ts` | no | no |
| `src/app/api/u/[token]/route.ts` | **yes** | **yes** |

The hook escapes `[` and `]` itself before its `[[ == ]]` test, precisely so a
Next.js dynamic segment matches literally. Pre-escaping in the intake defeats
that: the hook then escapes the escape. The audit's `globToRegExp` escapes
brackets for the same reason and reaches the same answer. The plain literal is
correct for both, and the intake now uses it.

Worth its own ticket, outside this branch: the audit's header states "character
classes are NOT supported (no intake uses them)", and the hook's comment says
the same. This intake used one, and both comments read as if pre-escaping were
the fix. Any intake generator emitting the escaped form produces a surface entry
that silently matches nothing — it fails closed in the hook (blocked writes) and
open in the audit only until a commit exists.
