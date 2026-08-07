# Round-1 triage — consolidated across all three axes

**Round:** `branchReviewRounds = 1`. **Gate at review time:** GREEN 26/26, full
mode, `lastGreenGateSha = 7f4658c8`.

| Axis | Verdict | Findings |
|---|---|---|
| Spec & correctness | APPROVE WITH CHANGES | 2 High, 4 Medium, 4 Low |
| Standards & maintainability | REQUEST CHANGES | 2 High, 5 Medium, 4 Low |
| Adversarial approach (Codex) | needs-attention | 2 high, 3 medium |

Reports: `spec-correctness-round-1.md`, `standards-maintainability-round-1.md`,
`adversarial-approach-round-1.md`. Full findings live there; this file records
only the verdicts and the reasoning that a resumed session must inherit.

Spec confirmed the two things the step-6 read-back deliberately carried into
review rather than settling — and both came back as real gaps. It also confirmed
the clean bill on the parts that matter most: **no edit-surface drift, no scope
creep, zero new analytics emissions** (the D7 deferral holds), and the consent
state machine, first-write-wins terminality, four-producer row-lock discipline,
transaction/rollback boundaries and lineage SQL are correct and well tested. The
defects cluster on the **edges** of the accepted path, not its centre.

---

## Cross-agent convergence

Independent agents landing on the same defect is the strongest signal in the
round. Four did:

| Defect | Found by | Status |
|---|---|---|
| `run_reason` divergence: the three gates suppress on **any** completed run, the view scopes to `'initial'` | spec #4, standards #7 | **CONFIRMED** — a completed *reactivation* run permanently suppresses an initial import the banner still reports as `importing`, on a 4s poll, forever |
| GET takes an exclusive `businesses` row lock + attempts an `UPDATE` on **every** request | codex #5, standards #3 | **CONFIRMED** at `route.ts:60-73` |
| The source tripwire overclaims and never checks the `b.` alias | spec #6, spec #7, standards #10, codex #4 | **CONFIRMED** — D9 named it as the alias mitigation; it does not mention the alias |
| Rejected/no-op decisions are invisible in the banner | spec #2, standards #6 | **CONFIRMED** — no `onError`, and `readOnly` is not passed |

---

## ACCEPTED — fix in round 1

| # | Sev | Source | Item |
|---|---|---|---|
| A1 | High | standards #1 | GET writes behind `allowReadOnly: true`. A past-due read-only owner's dashboard render mints a 7-day offer they can never answer (POST 402s), and derived expiry is terminal — permanently consuming the one-time offer. Verified: `resolve-owner-scope.ts:66-67`, whose own JSDoc scopes it to "owner **mutation** routes". |
| A2 | High | spec #1 | The intake's `observability` item 2 — the decision-transaction log line naming the rejection class + `business_id` — **does not exist**. The three enqueue-gate lines do. This is a locked-contract item and the D7 deferral's replacement signal. |
| A3 | High | spec #2 + standards #6 | Decision mutation has no `onError`; a 409/404 leaves live buttons, no message, no refetch. The late click is the *ordinary* case here (expiry is derived, nothing fires at the deadline). `readOnly` also isn't passed, so a read-only owner gets live CTAs whose 402 is swallowed. |
| A4 | Med | spec #4 + standards #7 | Align the completed-run predicate. The gates scope to `run_reason = 'initial'`, matching the view — reactivation runs recur by design and must not suppress the one-time initial import. |
| A5 | Med | codex #5 + standards #3 | Guard the GET self-heal behind a cheap read-only precondition (`pending` + NULL deadline — the only state `createImportOffer` can act on). Does **not** re-implement the junction check, so `createImportOffer` stays its single owner; correctness is unaffected because the transaction re-checks regardless. Largely subsumed by A1. |
| A6 | Med | spec #5 | `LiveRegion` is mounted together with its message on every terminal branch, violating its own documented "render it unconditionally" contract — title 68's announcement will not fire, and its DOM-presence assertion cannot catch that. A promised test that does not test its title. |
| A7 | Med | spec #6/#7 + standards #10 | The tripwire claims it "survives a FIFTH producer" — it cannot: four hard-coded paths, nothing enumerates enqueue sites, and `segment()` with no end marker slices to EOF so an appended unlocked producer inherits the earlier `FOR UPDATE`. Fix the claim and add the missing `b.`-alias assertion D9 credited it with. |
| A8 | Low | standards #4 | Three JSDocs still describe the `needs_backfill` predicate this diff deletes. CLAUDE.md: "grep the filename to clean every cross-reference in the same change." |
| A9 | Low | spec #9 | The guarded UPDATE and the outbox dedup subquery omit `account_id`, contradicting the module's own stated contract at `:112-118`. Safe today only via the preceding account-scoped `FOR UPDATE` — cheap defence in depth on a consent write. |
| A10 | Low | standards #8, #9 | `ViewRow.outbox_status` is dead and re-spells the exported union; the banner hand-duplicates the wire contract and casts it unvalidated instead of `import type`-ing it. |

## REJECTED

| # | Source | Reasoning |
|---|---|---|
| R1 | codex #3 — persist an immutable junction timestamp, derive the deadline from it | This **is** the junction anchor. It was built in plan revisions 2–3, produced two High findings across two review rounds, and was deleted by owner adjudication on 2026-08-06. The glossary records the current behaviour as intentional: "a self-healed offer starts a fresh 7 days at the repair, which is more generous and is the point." Codex itself confirms the NULL-only guard prevents any infinite-extension loop — the property that actually needed proving. Re-opening this would be the third attempt at a self-invented requirement. |
| R2 | codex #5 — "defeats dashboard caching" | Locked decision. Sourcing the banner outside the Redis-cached payload is deliberate: a declined offer would otherwise re-render for the whole TTL. The row-lock half of this finding is accepted separately as A5. |
| R3 | codex #2 — inherited `accepted` causes a second import for the same place | Reviews are stored per `business_id`; a re-added row has zero reviews and genuinely needs its inventory. D3's table says exactly this and it is right. |
| R4 | codex #4 — restore the alias parameter via identifier composition | Directly reverses D9's recorded reason, which still holds: `db(alias)` is correct against real Postgres but dies against the repo's hand-rolled `sql` mocks in four directories. Making a fragment called from four producers depend on every mock in the repo growing identifier support is the worse trade. The gap is closed by A7's assertion instead. |
| R5 | spec #10 — the terminal `imported`/`empty` banner is permanent | Deferred, not rejected on merits: owner decision #4 says the banner carries "offer → importing → outcome → **gone**", so a permanent terminal banner is arguably contract drift. Raised with the owner rather than patched, since "gone" has two defensible readings (auto-dismiss vs. dismiss-on-acknowledge). |

## SURFACED TO OWNER — not patchable by the orchestrator

| # | Source | Why it is the owner's call |
|---|---|---|
| O1 | codex #1 | Consent is not enforced at the worker trust boundary. Factually correct and **already known** — D1 + ADR 0015 R2 + the `Import consent` glossary entry all state the fail-closed guard is #679's. Codex's own recommendation ("hold behind a rollout gate until #679 is deployed") is materially what ADR 0015 R2 decided. Surfaced because an adversarial *no-ship* verdict on the feature's core guarantee deserves conscious re-affirmation, not a citation. |
| O2 | codex #2 (narrow form) | `add-location-tx.ts:280-306` writes `import_offer_expires_at` directly, bypassing `createImportOffer` — whose header says it proves both junction halves *because "the callers do not check, so the helper must."* Confirmed reachable: archive a location with a live unanswered offer → re-add the same place → the new row shows an answerable offer with **no active connection**. Not a consent violation (the owner was genuinely offered the import for that place; nothing imports without their Yes) — the blast is an enqueue the worker cannot service. Every remedy trades against a locked D3 row: leaving the deadline NULL fixes the live-pending case but makes an *expired* sibling's re-added row eligible for a fresh offer, contradicting D3's locked "never re-offered". |
| O3 | standards #2 | The initial-import enqueue is triplicated across three directories with the completed-run guard spelled three different ways. **The recorded blocker is false** — verified `outbox-seam-audit.ts:84` pins `HELPER_MODULE` to `job-outbox-helpers.ts` and `:458` derives coverage only from it, so extracting a shared function into `import-consent.ts` leaves one raw INSERT for a helper-less topic, which is legal. The handoff conflated "mint a helper in `job-outbox-helpers.ts`" (which *would* turn every raw producer red) with "extract a shared function anywhere". Not cosmetic: A4 shows the copies have already diverged. But it touches all four producers — the highest-risk code on the branch — after a green gate, so the risk appetite is the owner's call. |
