# Restraint policy v-watch — locked decisions (ticket #533)

> **Status:** Locked 2026-07-23 (grilling session, wayfinder map #528).
> Resolves ticket #533; binds implementation ticket #542 (`evaluateAsk`) and
> prototype ticket #537 (watch-mode batch screen).
> Compliance basis: the #531 research reference
> (`research/solicitation-policy-constraints` →
> `docs/research/2026-07-23-solicitation-policy-constraints.md`), whose row 1
> (gating ban binds SELECTION even in watch-mode) shaped every choice below.
> Companion ADR: `docs/adr/0011-sentiment-blind-withhold-enum.md`.

## 1. Withhold-reason enum (closed, six reasons)

`evaluateAsk(candidate, context) → send | withhold(reason, evidence)` with
exactly these reason codes. The enum is a public contract: #542 tests each
code as a contract, and the batch UI renders them verbatim.

| Reason | Fires when | Why it is sentiment-blind |
|---|---|---|
| `no_consent` | candidate row is not covered by the upload's consent attestation (exact coverage semantics locked in #535) | consent status only |
| `suppressed` | contact is on the suppression list | opt-out status only |
| `already_reviewed` | contact matched to an existing review — **any rating** | fires on existence of a review, never its sentiment |
| `stale_visit` | `today − last_visit_date > freshness_window_days` for the business's vertical | recency arithmetic only |
| `over_contacted` | candidate was in the would-have-sent set of a recent prior batch (simulated contact history — watch-mode must behave exactly as send-mode will) | frequency only |
| `velocity_banked` | per-candidate gates passed but the batch cap is reached; candidate is banked for a future batch | volume shaping only |

**`recent_negative` is rejected permanently** (not deferred): withholding
asks from customers with known/predicted negative sentiment is the mechanism
Google's gating ban describes ("selectively solicit positive reviews").
See ADR 0011.

**Boundary rule:** ingest hygiene (malformed contact handles, duplicate rows,
unparseable dates) is #535 upload-time **validation rejection**, not a
withhold. The restraint policy only ever sees valid candidates; the spoilage
report shows restraint, not data cleaning.

`suppressed` ships in the enum but may never fire in v1 — the suppression
ledger is send-mode scope; the only v-watch source is an owner manually
marking a contact never-contact. Reserving the code now keeps the enum stable
when send-mode lands.

## 2. Precedence — first-match wins

Gates are evaluated in a fixed order and short-circuit on the first failure;
a withhold carries exactly one reason:

```
no_consent → suppressed → already_reviewed → stale_visit → over_contacted → velocity_banked
```

Ordering rationale: *eligibility* (consent, suppression — asking would be
improper regardless) → *relevance* (already reviewed, stale) →
*pacing* (over-contacted, velocity). `velocity_banked` must be last: it is
the only batch-relative gate, assessable only against the pool that survived
every per-candidate gate, and banked candidates are expected to return.

Evaluate-all with multiple reported reasons was rejected for v1; a future
upgrade is additive (`secondary_reasons`), not a contract break.

## 3. Freshness — hard window per vertical

v1 freshness is a **hard window**, not a decay score: one integer
`freshness_window_days` per vertical; `stale_visit` fires iff
`today − last_visit_date > window`. "Decay" survives only as the future
direction (learned curves replace the window *behind the same gate*; enum and
evidence shape do not change).

### 3.1 Vertical resolution

The policy module owns a closed vertical enum and a **pure, deterministic
keyword mapper** from the owner-typed free-text `businesses.category` to a
vertical, falling back to `other`. No schema change, no owner-facing knob in
v1. The resolved vertical and matched keyword are recorded in evidence, so a
misclassification is visible, never silent. An explicit owner-set vertical
can later slot in as an override input to the same mapper.

### 3.2 Day-one windows (tunable constants, one table, single owner)

| Vertical | `freshness_window_days` | Anchor |
|---|---|---|
| `food_and_drink` | 14 | frequent low-ticket visits; memory fades in days |
| `retail` | 14 | same profile as dining |
| `personal_care` | 21 | results visible for weeks |
| `fitness` | 21 | recurring visits; individual sessions blur |
| `medical_dental` | 30 | infrequent, memorable; sensitivity argues against older asks |
| `automotive` | 30 | infrequent, high-ticket, memorable |
| `home_services` | 45 | rare, high-ticket, highly memorable |
| `other` | 30 | conservative middle (also the unmapped/empty-category fallback) |

Explicitly day-one defaults to be replaced by learned curves; every evidence
snapshot records the window that was applied.

## 4. Evidence snapshot — typed discriminated union

Immutable at decision time, JSON-serializable, re-explainable without
re-running the policy. Common envelope on every withhold:

- `policy_version` — identifier of the constants table + gate logic that
  produced the decision (same pattern as `prompt-policy.ts`'s version hash)
- `decided_at`
- candidate row reference **by ID only — contact PII is never duplicated
  into evidence** (CCPA-family duties from #531 §4: one authoritative home
  for contact data)

Per-reason payloads:

| Reason | Evidence fields |
|---|---|
| `stale_visit` | `last_visit_date`, `days_since_visit`, `vertical`, `matched_keyword`, `freshness_window_days` |
| `already_reviewed` | `review_id`, `review_date` — **never the star rating** (rating in evidence would rebuild the gating artifact through the display; see ADR 0011) |
| `over_contacted` | `prior_batch_id`, `prior_decision_at`, `min_gap_days` |
| `no_consent` | `upload_id`, missing attestation coverage (semantics finalized in #535) |
| `suppressed` | `suppression_source`, `suppressed_at` |
| `velocity_banked` | `batch_cap`, `eligible_count`, candidate's deterministic ordering basis |

Storage home is #534/#542's call (the run spine's `agent_run_steps.detail`
JSONB is the obvious precedent); the format above is what is locked here.

## 5. Conservatism — v1 posture

1. **Deterministic rules only; no LLM anywhere in the decision path.**
   `evaluateAsk` is a pure function — same candidate + context in, same
   decision out — testable to exhaustion, and every gate explainable to
   Google or a regulator as arithmetic. LLM-assisted anything (e.g. fuzzy
   contact-to-review matching) is a separate future decision routed through
   Judge/eval machinery.
2. **Banking order is most-recent-visit-first.** When the cap forces a
   choice, keep the freshest visits, bank the rest; ties break on candidate
   row ID (UUIDv7 is time-ordered) so ordering is total and reproducible.
3. **Day-one batch cap: 25 per batch**, a tunable constant in the same table
   as the freshness windows. Google's velocity concern is an enforcement
   heuristic, not a written rule (#531 §1.5) — the cap is a guardrail we
   own, cost-free to tune in watch-mode.
