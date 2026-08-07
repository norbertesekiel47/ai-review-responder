# Adversarial approach review — round 1 (Codex)

**Axis:** approach / design / assumptions (NOT line-level defects — the spec and
standards agents own those).
**Target:** branch diff against `349c8c57`.
**Codex thread:** `019fdb9d-b9f5-73c2-9e8b-9daa39a92950`
**Codex verdict:** `needs-attention` — *"No-ship: consent is not enforced at the
trust boundary, and the offer/lineage model permits stale or inherited
authorization to trigger imports outside the intended junction window."*

The brief explicitly told it to attack five assumptions and NOT to re-litigate
the spec's locked D1–D10 table. Three of its five findings land on decisions
that were locked by owner adjudication or by ADR 0015 — the reasoning is
recorded per finding rather than dismissed by citation.

---

## Findings table (as returned)

| # | Severity | Location | Finding |
|---|---|---|---|
| 1 | high | `worker/jobs/zernio/ZernioBackfillWorker.ts:198-215` | Consent enforcement stops before the authoritative worker boundary |
| 2 | high | `src/lib/locations/add-location-tx.ts:243-307` | Archived-row inheritance conflates permanent suppression with reusable authorization |
| 3 | medium | `src/lib/reviews/import-consent.ts:185-198` | A failed junction write can create a fresh offer arbitrarily long after eligibility |
| 4 | medium | `src/lib/reviews/import-consent.ts:72-106` | The shared consent predicate has an unenforced SQL alias precondition |
| 5 | medium | `src/components/dashboard/account-state/ImportOfferBanner.tsx:44-71` | The uncached banner endpoint defeats dashboard caching and fails invisibly |

---

## Verification performed by the orchestrator

Findings 2, 4 and 5 were checked against code before triage rather than taken on
the reviewer's word. Finding 1 is a restatement of a known accepted state;
finding 3 recommends a design that was already built and deleted.

### Finding 2 — CONFIRMED REACHABLE, and it is the one new thing this review found

The sub-claim worth extracting from finding 2 is not "inheritance is wrong in
general" (that is D3, locked and twice-reviewed). It is narrower and it holds:

**`add-location-tx.ts:280-306` writes `import_offer_expires_at` directly,
bypassing `createImportOffer` — the module that exists specifically to prove the
junction.** `createImportOffer`'s own header states the reason it proves both
halves in its own SQL: *"the callers do not check, so the helper must."*
Inheritance is a caller that writes the column without going through it.

The three-step path, each step verified:

1. `add-location-tx.ts:280-306` — the `UPDATE … SET import_offer_expires_at =
   sib.import_offer_expires_at` copies a **live deadline** from the archived
   sibling with no junction predicate of any kind.
2. `import-offer-view.ts:105-109` — the view returns `state: 'offer'` for any
   `pending` row with a non-NULL deadline. No junction check.
3. `import-consent.ts` `recordImportDecisionAndEnqueue` — the guarded transition
   requires `pending AND import_offer_expires_at IS NOT NULL AND > now()`. No
   junction check, by design.

**Reachable scenario:** connect + subscribe location A → offer created (7-day
deadline) → archive A while the offer is still live and unanswered → re-add the
same place as B → B inherits `pending` + A's live deadline → the banner offers on
B, which has **no active `zernio_connections` row** and may predate its own
activation → owner accepts → `zernio_initial_backfill` is enqueued for an
unconnected location.

**Severity is lower than Codex rates it, and the distinction matters.** This is
not a consent violation: the owner really was offered the import for that place,
and nothing imports without their Yes. The blast radius is an enqueue for a
location with no connection, which the worker cannot service. So: a broken
invariant and a confusing failed run, not unauthorized data access.

**Not owner-fixable by me.** Every remedy trades against a locked D3 row. Leaving
the deadline NULL on inheritance fixes this cleanly for the live-pending case,
but it also makes an *expired* sibling's re-added row eligible for a fresh offer
at its new junction — which contradicts D3's locked "pending, deadline passed →
never re-offered". That is a product decision about what "one-time" means across
an archive/re-add boundary. **Surfaced to the owner, not patched.**

Codex's second sub-claim — that inherited `accepted` causes a second import for
the same place — is **rejected**. Reviews are stored per `business_id`; a re-added
row has zero reviews and genuinely needs its inventory. D3's table says exactly
this and it is right.

### Finding 4 — CONFIRMED, mitigation partially exists

`import-consent.ts:98` — `importConsentStateSql(db)` takes no interpolation and
hard-codes `b.`. Real risk, and this is the item the step-6 read-back already
carried into review from D9 rather than settling.

Codex's recommendation (restore an alias parameter via Postgres.js identifier
composition, and upgrade the mocks) is a direct reversal of D9's recorded reason
for removing it: `db(alias)` is correct against real Postgres but dies against
the repo's hand-rolled `sql` mocks in four separate directories, which implement
only the tagged-template call form. "A fragment called from four producers must
not require every mock in the repo to grow identifier support" is a defensible
call, and reversing it is a bigger change than the risk warrants at this stage.

The mitigation is `__tests__/import-consent-lock-order-source.test.ts`, a
source-level tripwire. **Whether it actually pins the alias at all call sites is
delegated to the spec agent** — that is a coverage question, not an approach one.

### Finding 5 — CONFIRMED as to mechanism; split into three claims, only one accepted

Verified at `route.ts:60-73`: the GET **unconditionally** opens `sql.begin`, takes
`SELECT … FOR UPDATE` on the `businesses` row, and calls `createImportOffer` (an
`UPDATE`) on **every** request — including for locations in terminal
`accepted`/`declined` states and locations nowhere near a junction, where the
self-heal provably cannot do anything. The same row is locked by the four
producers and by the decision POST.

- **"Defeats dashboard caching" — REJECTED.** Sourcing the banner outside the
  Redis-cached payload is the locked decision, and the reason is sound: a declined
  offer would otherwise re-render for the whole TTL.
- **"Unconditional row lock + UPDATE on every dashboard mount" — ACCEPTED as a
  real, cheap-to-fix contention issue.** A read-only precondition (`pending` +
  NULL deadline — the only state in which `createImportOffer` can act) would skip
  the lock in the overwhelmingly common case. It does **not** re-implement the
  junction check, so it respects the route header's constraint 2 that
  `createImportOffer` stays the single owner of that condition; correctness is
  unaffected because the transaction re-checks everything anyway.
- **"Fails invisibly / no retry" — NOTED, not accepted as a defect.** A failed
  banner fetch hides the prompt for that render; the offer stays live and the next
  dashboard load retries. Not data loss.

---

## Triage verdicts

| # | Verdict | Reasoning |
|---|---|---|
| 1 | **REJECT (blocking) / SURFACE (informational)** | Factually correct and already known: this is deviations D1 + ADR 0015 R2 + the `Import consent` glossary entry, all of which state that the fail-closed worker guard is #679's and does not exist yet. The interim opening is owner-accepted on the standing condition that production holds zero customers and GA stays gated behind #286–#290, and merge order #677 → #679 narrows it rather than leaving it open. Codex's own recommendation ("hold behind a rollout gate until #679 is deployed") is materially what ADR 0015 R2 already decided. Surfaced to the owner because an adversarial no-ship verdict on the feature's core guarantee should be a conscious re-affirmation, not a citation. |
| 2 | **PARTIAL ACCEPT → SURFACE to owner** | The narrow sub-claim is confirmed reachable and is a genuine invariant hole (see above). Every fix trades against a locked D3 row, so it is the owner's call, not a patch. The "second import" sub-claim is rejected. |
| 3 | **REJECT** | Recommends persisting an immutable junction timestamp and deriving the deadline from it — precisely the junction anchor that was built in plan revisions 2–3, produced two High findings across two review rounds, and was deleted by owner adjudication on 2026-08-06. The glossary records the resulting behaviour as intentional: "a self-healed offer starts a fresh 7 days at the repair, which is more generous and is the point." Codex also confirms the NULL-only guard prevents any infinite-extension loop, which is the property that actually needed proving. Re-opening this would be the third attempt at a self-invented requirement. |
| 4 | **ACCEPT (risk confirmed) — remedy rejected in favour of the existing tripwire** | Alias fragility is real; Codex's fix reverses D9 for a mock-compatibility reason that still holds. Coverage of the source tripwire delegated to the spec agent. |
| 5 | **PARTIAL ACCEPT** | Unconditional lock + `UPDATE` on every dashboard mount accepted as a cheap contention fix. Caching framing rejected (locked decision). Silent-null noted only. |

**Net:** zero findings that block on their own merits; one confirmed invariant
hole (2) and one confirmed contention issue (5) carried forward; two rejections
of owner-locked decisions (1, 3); one confirmed risk whose proposed remedy is
worse than the recorded status quo (4).
