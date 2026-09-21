# Adversarial approach review — round 2, verification only (Codex gpt-6-astra, resumed session 01a0c4c8-81bc-7233-82a2-caeb36cba921)

- **F1 — PARTIALLY:** Deviations **D4** records the owner’s staging measurement and PR hold decision; it contains no measurement results, and “several times, wait” does not establish recovery at capacity.
- **F2 — ADDRESSED:** `src/components/auth/__tests__/useMfaEnrollment.test.tsx:155` now supplies `totp: [], all: [unverifiedFactor]`; the second-factor test also includes a realistic mixed fixture.
- **(e) — ADDRESSED:** `src/components/auth/useMfaEnrollment.ts:84` suppresses messages matching the current step-up regex; the added regression test asserts the generic fallback. Pattern duplication is explicitly recorded in D5.

**Defects introduced by the fix:** None identified in the committed delta.

**F1 staging plan:** Directionally correct, but insufficient as written. It must also measure:

1. **Actual capacity:** Start with zero verified factors at AAL1; repeat cancellation through the configured limit, recording counts and the exact rejection code. A few successful starts cannot establish whether unverified factors count.
2. **Expiry timing and trigger:** Record factor ages and a defined observation window; distinguish passive expiry from cleanup triggered by a subsequent enrollment. A finite wait without a known expiry bound is inconclusive.
3. **Recovery while already full:** After the expected expiry interval, attempt enrollment **at capacity**, then complete verification. This checks whether cleanup occurs before the limit check; expiry below capacity alone does not prove recovery.
4. **Temporary blockage:** Record how long enrollment remains blocked and whether recovery requires AAL2, deleting a verified factor, or operator intervention. “Eventually expires” can still leave a first-time owner unable to enroll for an unacceptable interval.

Keep the PR held for inconclusive results or failed recovery as well as non-expiry; the owner should explicitly accept any measured temporary blockage.

VERDICT: REVISE
