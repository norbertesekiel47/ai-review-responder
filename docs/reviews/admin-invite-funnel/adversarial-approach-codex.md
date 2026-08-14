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

