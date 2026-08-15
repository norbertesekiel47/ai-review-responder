# Adversarial approach review — Codex (step 7, round 1)

Branch: admin-invite-funnel · base 2b3c872a · run review-mst8ty7f-9e6kfn

---

# Codex Adversarial Review

Target: branch diff against 2b3c872ab9229807cd7aa93259daa85ccdedd012
Verdict: needs-attention

No-ship: the branch still ships an explicitly unverified Supabase Auth contract, and its coupon eligibility can comp non-invitees because it reuses a historically overloaded field.

Findings:
- [high] Resend eligibility and error handling are still based on an unverified Supabase contract (src/lib/onboarding/resend-invite.ts:328-361)
  The action treats `last_sign_in_at` as proof that an invite was accepted, then assumes a second `inviteUserByEmail` is safe for every null timestamp. The module itself says these semantics and error codes have not been observed in staging, and the staging evidence records this as still outstanding. The tests only supply hand-written provider responses, so they cannot detect an accepted owner whose provider state differs, or a pending invite that Supabase refuses/replaces differently. That can make the resend button either unusable for legitimate invitees or send a new credential-bearing invite to an owner already using the account.
  Recommendation: Do not enable this route in production until a real staging matrix verifies accepted, unaccepted, deleted-user, and rate-limited cases. Replace the assumed mapping/eligibility signal with the observed supported Supabase behavior, and retain a recorded integration smoke artifact.
- [high] `onboarded_by IS NOT NULL` is not a trustworthy coupon-entitlement marker (src/lib/payments/plan-activation.ts:218-225)
  Coupon selection grants the comp solely from a non-null primary-business `onboarded_by`. But migration 025 backfilled every previously-null business with the oldest admin/sales-partner user, while the same field also denotes attribution and drives self-serve cleanup/trial policy. Thus historical self-serve accounts can be classified as invited and receive the three-month comp; conversely the field cannot express an admin-created but intentionally non-comped account. The snapshot only freezes this incorrect decision, so idempotency makes recovery harder rather than preventing the financial error.
  Recommendation: Use a dedicated, immutable account-level comp entitlement/version set only by this admin-invite flow, with an explicit migration/backfill policy. Resolve and snapshot that entitlement under the existing activation lock.

Next steps:
- Complete and record the real Supabase resend-contract staging probe before production rollout.
- Redesign coupon eligibility around an explicit entitlement rather than `onboarded_by`.

---

## Triage verdicts — round 1, 2026-08-14

- **[high] resend-invite rests on an unverified Supabase contract** — **ACCEPTED,
  already tracked as D-13.** No code change: the map is *unverifiable* without a
  real provider response, and guessing again is what D-13 records. Its
  containment stands (code-keyed branches, unknown → 502 + logged raw code,
  never auto-retried, header marked `CONTRACT NOT YET VERIFIED`). The staging
  probe — accepted / unaccepted / deleted-user / rate-limited — remains a live
  blocking ops item before the route is used in production. Codex independently
  reaching the same conclusion as the spec axis raises its priority, not its
  scope.
- **[high] `onboarded_by IS NOT NULL` is not a trustworthy comp marker** —
  **REJECTED ON THE PREMISE**, with one real residue carried forward.
  - The claim that "historical self-serve accounts can be classified as invited"
    is false: self-serve signup shipped in the **same commit** as 025's backfill
    (`d0f3d9fa`, #7), and `2026-04-23-owner-self-serve-signup-design.md:220,224`
    records that admin onboarding never populated `onboarded_by` before then. So
    every row the backfill touched was genuinely admin-onboarded; there was no
    self-serve population to mislabel. The backfill was correct-by-construction,
    and `:257` documents the placeholder id as deliberately informational.
  - The recommended fix (a dedicated per-account comp entitlement) is
    additionally `non_goals[2]` of the locked intake.
  - **A migration NULLing the backfilled rows was drafted, owner-approved, then
    withdrawn** once the premise was checked. It would have granted those
    accounts trial eligibility they must not have (`plan-activation.ts` gates
    trials on `onboarded_by IS NULL`) and stripped layer 2 of
    `CleanupAbandonedSignupsPoller`'s three-layer safety — a data-loss risk in
    service of a non-problem.
  - **Real residue, closed differently:** a *legacy* admin-onboarded account
    still sitting in `pending_payment` would draw a comp once a live coupon
    exists. That is semantically consistent with the marker but not who the comp
    is for, so it is now a **blocking pre-flight audit** in
    `docs/launch-checklist.md` ahead of Phase F2, rather than a code or data
    change.

**Net:** one finding accepted as an already-tracked ops blocker, one rejected on
verified fact with its genuine residue converted into a launch gate.

