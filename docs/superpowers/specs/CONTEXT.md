# Auto-Approval — Domain Language (CONTEXT.md)

Glossary for the auto-approval design spec
(`docs/superpowers/specs/2026-05-31-auto-approval-design.md`). One authoritative
definition per term; the spec body and the eventual implementation derive from
these. If a term here disagrees with CLAUDE.md, CLAUDE.md wins.

## Core terms

- **Auto-approval** — an owner-configured policy that lets a generated reply skip
  the *owner approval* step and post to Google automatically. It can **never**
  skip moderation, billing, or audit. It only ever *removes the owner step*.

- **Policy** — a row in `auto_approval_policies` holding one nullable threshold,
  `auto_approve_min_star ∈ {NULL, 1..5}`. `NULL` = disabled (manual). Scoped to an
  account default (`location_id IS NULL`) with an optional per-location override.

- **`policyEligible`** — `auto_approve_min_star IS NOT NULL` AND the review's
  `star_rating IS NOT NULL` AND `star_rating >= auto_approve_min_star`. A NULL star
  is never eligible (guarded explicitly, not via SQL NULL-comparison semantics).

- **Origin lane** — *which ingestion path produced this draft.* An explicit,
  greppable, **required** enum carried in the `generate_response` payload. It is
  **fail-closed**: only the exact value `'live_ingest'` is auto-eligible; every
  other value — `'backfill'`, `'regenerate'`, an unknown string, *or a missing
  field* — resolves to manual. There is **no default-to-live**.
  - `'live_ingest'` — live, post-connect reviews (`ZernioReviewIngestWorker` /
    `ZernioRecentReviewPoller` → `process-review.ts`, never suppresses). **The
    only auto-eligible value.**
  - `'backfill'` — first-connect historical backfill (`ZernioBackfillWorker` →
    `process-review.ts`, suppresses). Never auto.
  - `'regenerate'` — re-draft of an existing/posted reply. **Five producers**,
    all of which must set this value: `past-replies/draft/route.ts:228`; the
    approval supersede-regenerate paths `token-mode.ts:153`, `session-mode.ts:174`,
    `callback-mode.ts:99`; and the admin held-draft re-generate
    `admin/flagged/route.ts:254`. Never auto.
  - **`isLiveIngestLane`** = `origin_lane === 'live_ingest'` (exact match only).
  - This signal is **distinct from `suppressNotification`**: that flag has more
    than one producer (backfill *and* the regenerate lanes set it), so it cannot
    mean "is backfill." Origin lane is the single owner of "which lane," carrying
    its own meaning instead of overloading a notification flag.

- **`suppressNotification`** — *do not send the owner an approval notification for
  this draft.* Set by both backfill and the regenerate path. It is **not** an
  auto-eligibility signal and must not be read as one (see Origin lane).

- **`publisherSubscriptionOK`** — result of a **second** `checkSubscription` call
  with `workerType: 'publisher'` (the generator gate in `load-context.ts` stays
  for its own purpose). Diverges from the generator gate on exactly one status:
  `pending_payment` is allowed for `'generator'` but denied for `'publisher'`.

- **`providerModerationClean`** — the OpenAI moderation provider actually ran and
  passed for *this* draft. Implemented as the tri-state marker
  `moderation.categories.openai_moderation === 'clean'`. The marker is `'clean'`
  (passed), `'error'` (provider failed, fail-open to local rules), or **absent**
  (provider disabled, or the provider *flagged* — on a provider flag the field is
  never set to `'flagged'`). Auto requires the `'clean'` value **together with**
  `!moderation.flagged`; neither conjunct alone is sufficient.

- **`held`** — `recordModerationAndHold(...)` returned `true`, i.e. a
  high-severity flag wrote a `flagged_responses` row and the draft is held for
  admin review. Known **only inside** the response-persistence transaction, which
  is why the auto/manual decision is finalized there.

- **`approval_method`** — new `responses` column, `'owner' | 'auto_policy'`,
  default `'owner'`. Records *how* a response was approved without overloading
  `status`. Auto-approval reuses `status = 'approved'` and sets
  `approval_method = 'auto_policy'`; it never introduces a new status value.

- **`'auto_policy'` (audit)** — value written to `approval_audit_log.auth_method`
  for an auto-approval decision. Requires the migration-055 amendment to that
  column's CHECK constraint (`'token','owner_session'` → add `'auto_policy'`),
  otherwise the INSERT throws.

## The auto predicate (single source)

```
auto = policyEligible
    && isLiveIngestLane          // origin_lane === 'live_ingest'
    && publisherSubscriptionOK   // 2nd checkSubscription, workerType:'publisher'
    && providerModerationClean   // categories.openai_moderation === 'clean'
    && !moderation.flagged       // zero flags (high HOLDS; medium/low ⇒ manual)
    && !held                     // resolved inside the persist transaction
```

Any condition false ⇒ **manual** (`pending_approval`). Any resolution error ⇒
**manual** (fail-closed). No policy row ⇒ **manual** (opt-in default).
