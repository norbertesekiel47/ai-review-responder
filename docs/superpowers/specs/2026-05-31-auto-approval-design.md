# Auto-Approval Policy — Design Spec

- **Date:** 2026-05-31
- **Status:** Draft — design decisions approved; **NOT implemented**. CLAUDE.md invariants #3/#4/#11 remain authoritative until the implementation PR lands.
- **Owner:** Norbert Esekiel
- **Origin:** Potential-client survey — clients want to choose which reviews get fully automated (drafting → posting) vs. which require manual owner approval.

---

## 1. Problem

Today every generated response requires an explicit human approval before it posts to Google (CLAUDE.md invariant #3, "No auto-posting"). The survey says some clients want hands-off automation for routine reviews while keeping a human in the loop for sensitive ones — typically by star rating (e.g. auto-respond to 3–5★, manually handle 1–2★).

We need an **owner-configurable auto-approval policy** that lets a client pick, in advance, which reviews skip the owner-approval step — **without** removing the safety guarantees the approval architecture exists to enforce.

## 2. Goals / Non-goals (v1)

**Goals**
- Per-client policy: "all auto", "all manual" (today's behavior), or "auto if star ≥ N".
- Account-level default with optional per-location override (multi-location clients).
- Auto-approval **never** weakens moderation, token security, subscription gating, or auditability.
- Safe, opt-in default: no policy configured ⇒ everything stays manual (current behavior).

**Non-goals (v1)**
- Signals other than **star rating** (sentiment, keyword match, length, language) — clean future extension, explicitly out of scope.
- Per-reviewer or per-campaign rules.
- Auto-*editing* of drafts — auto-approval posts the generated draft as-is or holds it; it never silently rewrites.

## 3. Locked decisions

1. **Moderation is an absolute veto** (approved in design dialogue). A draft flagged high-severity unsafe (invariant #4) is held for manual/admin review and **never** auto-posts, regardless of policy. Auto-approval skips the *owner* step, never the *safety* step.
2. **Scope = account default + per-location override** (approved). Mirrors owner channel-enrollment (account-scoped default keyed by `location_id IS NULL`, per-location override row) and the multi-location settings pattern. Respects invariant #9 (`accounts` = billing parent, `businesses` = location).
3. **Dimension = star rating only, threshold model** (recommended; not objected). A single `auto_approve_min_star` expresses every survey case (see §5). Richer signals are a future generalization.

## 4. Safety model (the core)

Auto-approval is **subordinate** to every existing guarantee. In priority order, a draft posts automatically **only if all** hold:

1. **Moderation passed** — not high-severity-held (invariant #4). The hold overrides policy.
2. **Subscription allows publishing** — same gate as manual publish (invariant #11): `active`, or `past_due` within grace. `cancelled` / `pending_payment` ⇒ no auto-post.
3. **Policy says auto** — resolved policy marks this (location, star rating) as auto.

If any fails, the response falls back to the **manual** path (owner notification + approval), exactly as today. Auto-approval can only ever **remove the owner step** — it can never bypass moderation, billing, or audit.

**Fail-closed:** any error resolving the policy (missing row, malformed value, DB error) ⇒ treat as **manual**. We never auto-post on uncertainty.

**Opt-in default:** absence of any policy row ⇒ manual. New accounts and newly-added locations are manual until the owner explicitly enables auto-approval.

## 5. Policy model & resolution

**Threshold model.** One nullable field, `auto_approve_min_star ∈ {NULL, 1..5}`:

| Client intent | `auto_approve_min_star` | Effect |
|---|---|---|
| All manual (today) | `NULL` | nothing auto-approves |
| Auto 3–5★, manual 1–2★ | `3` | auto if `star_rating ≥ 3` |
| All automated | `1` | auto for every rating |

**Resolution order** for a review at location `L` (account `A`, star `S`):
1. Per-location override row (`account_id = A, location_id = L`). If present, use it.
2. Else account default row (`account_id = A, location_id IS NULL`).
3. Else **manual** (no row = opt-out).
4. Decision = `auto` iff `min_star IS NOT NULL AND S >= min_star`.

This is the same override→default→fallback resolution used by owner channel enrollment.

## 6. Data model

New table `auto_approval_policies` (migration **055+**; next free number at implementation time — confirm against `migrations-log.md`):

```
id                   uuid  PK  (uuidv7)
account_id           uuid  NOT NULL  FK accounts(id)
location_id          uuid  NULL      FK businesses(id)   -- NULL = account default
auto_approve_min_star smallint NULL  -- NULL = disabled; 1..5 threshold
created_at           timestamptz NOT NULL default now()
updated_at           timestamptz NOT NULL default now()
```

- Partial unique indexes mirroring channel enrollment: one default per account (`UNIQUE (account_id) WHERE location_id IS NULL`) and one override per (account, location) (`UNIQUE (account_id, location_id) WHERE location_id IS NOT NULL`).
- `CHECK (auto_approve_min_star BETWEEN 1 AND 5)` when not null.
- All reads scoped by `account_id` (and `location_id`) per invariant #8; add to tenant-scope audit allowlist only if a justified cross-account admin read exists.

## 7. Decision flow & state machine

**Single chokepoint.** The auto/manual decision is resolved **once**, in the response-persistence step (`worker/jobs/response-generation/persist.ts`), immediately after moderation — the same transaction that persists the response. This keeps "no post without a decision" a single enforceable gate.

```
generate → moderate
  ├─ high-severity flag → flagged_responses + HOLD (invariant #4)         [unchanged; overrides all]
  └─ clean → resolve auto-approval decision (policy + subscription)
       ├─ AUTO  → status = 'auto_approved'  → enqueue publish via job_outbox
       │                                     → enqueue post-hoc FYI notification (see §8)
       └─ MANUAL→ status = 'pending_approval'→ enqueue send_notification     [today's behavior]
```

- **New response status `auto_approved`** — distinct, audited; added to the publisher's `ZERNIO_PUBLISHABLE_STATES` / `AWAITING_PUBLISH_STATUSES` (`src/lib/shared/response-status.ts`). **Never reuse `approved`** — the human-approved status must remain meaningful and distinguishable in audit.
- All enqueues use the transactional outbox (invariant #2); no Postgres-write-then-enqueue.
- The publisher path is otherwise unchanged — it already gates on publishable status + subscription, so an `auto_approved` row flows through the same posting + idempotency machinery.

## 8. Notification & audit

- **Post-hoc owner notification (recommended default):** after a successful auto-post, send a non-blocking "we auto-responded to this review" notice (own channel or batched into a digest). This is transparency/FYI, **not** an approval gate. *Open decision (§13).*
- **Audit (required):** every auto-approval decision is recorded — the resolved policy, threshold, star rating, location, and outcome — via the existing audit path (`src/lib/audit/log.ts`) and/or `api_costs` metadata, in the same transaction. Owners and support must be able to answer "why did this post automatically?"

## 9. Subscription & billing gating

Auto-post is a publisher action and inherits invariant #11 exactly:
- `cancelled` ⇒ no auto-post (and no manual post).
- `pending_payment` ⇒ publisher skips ⇒ auto-post skips; response falls to manual so the owner can act after paying.
- `past_due` ⇒ within 7-day grace, auto-post allowed; after grace, falls to manual.

A subscription-blocked auto-decision **degrades to manual** (notify owner) rather than dropping the response.

## 10. Error handling

- Policy resolution error ⇒ **manual** (fail-closed).
- Moderation error already fails open to local rules (invariant #4) but a high-severity local-rule flag still holds — unaffected.
- Auto-publish enqueue is idempotent via the outbox key (invariant #2; BullMQ `_` separator).
- Best-effort post-hoc notification wrapped in its own try/catch — never flips a completed auto-post to failed (per the worker fail-open gotcha).

## 11. Testing

- Policy resolution: override beats default; default applies; **no row ⇒ manual**.
- Threshold boundaries: `min_star = 3` ⇒ 2★ manual, 3★ auto; `min_star = 1` ⇒ all auto; `NULL` ⇒ all manual.
- **Moderation veto overrides auto** — high-severity draft is held even with `min_star = 1`.
- **Subscription blocks auto** — `pending_payment`/`cancelled` ⇒ falls to manual, no post.
- **Fail-closed** — resolution throws ⇒ manual, never auto.
- `auto_approved` is in the publishable set and flows through publisher idempotency.
- Audit row written for every auto decision; tenant-scope + RLS audits pass.
- Outbox idempotency for the auto-publish enqueue.

## 12. CLAUDE.md change-map (applied WITH the implementation PR, not before)

| Location | Change |
|---|---|
| **What this project is** (pipeline) | `Never auto-posts.` → posts via owner approval **or** owner-configured auto-approve policy; moderation can always veto |
| **Invariant #3** | Rewrite: no posting without an approval *decision* (explicit approval **or** owner-set policy); auto-approval **cannot** bypass moderation; still impossible to post without a decision |
| **Invariant #4** | Add: the high-severity hold **overrides auto-approval** — auto never posts a held draft |
| **Invariant #11** | Add: auto-post gated by subscription **identically** to manual publish |
| **New invariant #14** | Policy contract: account-default + per-location override, star-threshold, resolved once after moderation, **subordinate** to moderation veto + subscription guard; new audited status `auto_approved` (never reuse `approved`) |
| **Database** | New `auto_approval_policies` table; migration 055+ |
| **Where things live** | New `auto-approval-policy` skill (sibling of `approval-security`); **update `approval-security`** skill — it currently assumes every post is human-approved |

These edits flip the docs to the new reality **in the same commit** the code lands, so CLAUDE.md never describes a bypass that isn't yet built.

## 13. Open product decisions (recommended defaults; settle at implementation)

1. **Post-hoc notification** on auto-post — *recommend:* yes, batched/digest, non-blocking.
2. **Threshold vs per-rating map** — *recommend:* threshold for v1 (covers all survey cases); generalize to a per-rating set only if a non-monotonic case appears.
3. **First-N grace / onboarding ramp** — should a brand-new account be allowed `min_star = 1` immediately, or require a short manual-trust period first? *Recommend:* allow immediately but surface a confirmation in the settings UI; revisit if abuse appears.

## 14. Out of scope / future

- Non-star signals (sentiment, keywords, length, language).
- Auto-editing / auto-regeneration before posting.
- Per-reviewer rules, scheduling windows, A/B of auto vs manual.

---

## Next step

When ready to build: run the **writing-plans** skill against this spec to produce the phased implementation plan (policy table + migration → resolution module + tests → persist.ts decision integration → publisher status → settings UI → CLAUDE.md change-map). Anything touching the worker/migration rides `staging` first, then lands on `main` via PR (the CLAUDE.md change-map travels in that same PR).
