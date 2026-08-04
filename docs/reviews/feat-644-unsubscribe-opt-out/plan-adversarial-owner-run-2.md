# #644 plan revision 5 — owner-run `/codex:adversarial-review` #2

**Target:** branch diff against `main` · **Verdict: needs-attention** · 3 high + 1 medium.
All four **ACCEPTED**. Addressed in plan **revision 6**.

> "Do not ship this plan. It still permits a false opt-out confirmation, exposes an
> unbounded public workload path, and contains contradictory execution artifacts."

---

## 1. HIGH — spent-token replay can still produce a false success confirmation

`redeemed_at IS NOT NULL` was labelled `already_suppressed`, but it proves only that the
token was *previously* redeemed. That path performs no write and no ledger check, yet minted
a success receipt. **After an audited Correction-path removal, replaying the spent token
displays "You're unsubscribed" while no suppression exists** — the same false-success class
revision 5 was written to eliminate.

**Verdict: ACCEPT.** Revision 4 closed the *write* side of this hole (a spent token must not
re-suppress) and I left the *display* side open. Worse, revision 5 then attached a
cryptographic receipt to that unverified state, which made the false claim harder to doubt
rather than impossible to make.

**Fix (revision 6 §1.3):** split the spent branch on an explicit **current-ledger existence
check** for a `scope='global'` row on the token's own handle + channel:

| Claim | Ledger now | Outcome | Receipt |
|---|---|---|---|
| won | just written | `redeemed` | yes |
| lost, spent | global row exists | `already_suppressed` | yes — truthful |
| lost, spent | no global row | `already_redeemed_not_suppressed` | **no** → neutral page |
| lost, unspent | — | `unknown_token` | no |

The correction case deliberately does **not** re-suppress (round-3 finding 4), and the
neutral page carries the working `mailto:` so it does not dead-end. New invariant, stated
directly: **a receipt is never issued without a live suppression** — not "a receipt follows
a POST".

Deliberately **not** `suppressionMatchSql`: that fragment answers the send-time question
("may we contact this handle *for this account*?") and matches account-scoped rows too,
which would make §5.5's "or any other business that uses RepWorth" sentence false. Distinct
question, distinct query.

## 2. HIGH — the unrate-limited route leaves request and DB work unbounded

The exemption removed the limiter and the logging, but nothing bounds the *workload*: bodies
buffer against the app-wide 5 MB limit (`fastify-options.ts:21`) through the app-wide
urlencoded parser (`content-type-parsers.ts:18`), and every arbitrary token opens a
transaction with an UPDATE plus follow-up SELECT. Hostile traffic can saturate the shared
worker/DB pool, delaying other webhooks *and* valid opt-outs.

**Verdict: ACCEPT.** Removing the limiter removed the only thing bounding this route, and I
never replaced it. §9.2 forbids **rate limiting** — which *drops* a statutory opt-out on a
per-caller quota — not bounding induced work. A bulkhead **defers** with a retryable status;
`production.md` positively requires one.

**Fix (revision 6 §1.4b):** per-route `bodyLimit: 1024` (RFC 8058's body is ~30 bytes), plus
a bounded-concurrency semaphore that responds **503 + `Retry-After`** over the cap — the
same retryable shape already used for `unknown_token`, so provider behaviour stays uniform
and no opt-out is lost, only deferred. Tests cover oversized bodies, concurrency exhaustion,
and that neither is a per-recipient rate limit.

## 3. HIGH — the promised-test contract required incompatible behaviours

The intake still required an unknown token to "log a token-hash prefix" while other entries
required no per-request log and windowed aggregation only; and required a redirect "with
done" while others required the signed receipt and rejected a crafted `done`. No
implementation — and no promised-test gate — could satisfy both.

**Verdict: ACCEPT, and this is a repeat.** Owner-run review #1 raised exactly this drift
class; I fixed `user_visible_behavior`, `edge_cases` and `observability` and **never touched
the test titles**, which are the contract the gate actually enforces.

**Fix:** contradictory titles rewritten (`…returns 503 and emits no per-request log line`,
`…303s with a signed receipt`), and the contradiction sweep now runs across **all** contract
fields including `tests_to_add`.

## 4. MEDIUM — handoff and workflow state pointed at superseded metadata

The handoff header still said revision 4, named a stale HEAD with a stale commit count, and
linked to "plan, revision 2", while `.feature/state.json` still recorded the old HEAD — so
`/feature-resume` would hand the next implementer superseded instructions.

**Verdict: ACCEPT — third occurrence of the same class, so the fix is structural rather than
another patch.** The handoff no longer restates mutable facts at all. HEAD, phase, commit
count, revision label, promised-test count and armed-state now each have exactly one
authoritative source, and the handoff points at the command that reads it. `state.json` is
regenerated. One fact, one owner (`engineering.md`).
