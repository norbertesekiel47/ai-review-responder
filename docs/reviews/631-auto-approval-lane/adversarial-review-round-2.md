# Adversarial Review — Round 2 (verification only)

Target: fix commit `a459cea8ebac4a0af486342e2ce21edf5cddcec3` against round-1 findings + orchestrator triage in `docs/reviews/631-auto-approval-lane/adversarial-review-round-1.md`.

## A2 — bounce-then-anchor (accepted narrowly)

**RESOLVED.**

- `src/lib/solicitation/auto-approval.ts` — `AND nd.failed_at IS NULL` is present in both:
  - `selectAnchorCandidates`'s scan `EXISTS` (line ~526, alongside `nd.sent_at IS NOT NULL`).
  - `anchorOneBatch`'s CAS `MIN(sent_at)` subquery (line ~619, same `AND nd.failed_at IS NULL` clause).
- The section header comment above `selectAnchorCandidates`/the CAS states the semantic verbatim: "the anchor input is the first provider-accepted send not known to have failed at THIS moment (a bounce recorded after this CAS commits never moves the anchored deadline)" and the module-header comment: "acceptance alone is not evidence the owner was told... a bounce recorded AFTER the deadline is anchored does not move or clear an anchored deadline (the CAS is once-only by design)".
- Test `'a wrong-template or different-batch delivery row never anchors'` (`src/lib/solicitation/__tests__/auto-approval.integration.test.ts:1145`) gained a new `seedVetoNoticeDelivery(batchId, { sentAgo: '5 minutes', failedAgo: '4 minutes' })` case (sent+failed row, right template, right batch) with an inline comment tying it to "adversarial R1 finding 2". Ran this test live (`vitest -t "never anchors"` and the full "anchor" filter, 5/5 passed) — the tally stays `{ handled: 0, failed: 0 }` with the bounced row present.
- `scripts/ci/tenant-scope-allowlist.ts`'s `VETO_ANCHOR_SCAN_SQL`/`VETO_ANCHOR_SCAN_REASON` were refreshed to match the new SQL byte-for-byte (including the added `AND nd.failed_at IS NULL` clause) and the reason string now cites "without a recorded bounce (failed_at IS NULL — adversarial R1 finding 2)".
- `pnpm ci:tenant-scope` — **passed** (`entries: 393 (baseline: 393)`).

## A4 — pre-enable batches (rejected; comment-tightened)

**RESOLVED.**

- Test `'turning the auto flag on does not retroactively approve a previously built batch'` (`auto-approval.integration.test.ts:815`) now states the decision-at-finale lock inline: "The guarantee this test pins is EXACTLY this: NO SWEEP approves pre-flip batches... That finale deciding WITH CURRENT STATE — and so approving a batch built before the flip — is the locked decision-at-finale design, not a retroactivity leak." Ran live — passed.

## A1 — send-boundary re-auth (rejected; factual-basis check)

**CONFIRMED.** `src/lib/solicitation/dispatch.ts` module header, verbatim:

> "The **Dispatch gate** is per-CHILD and therefore per-CONTACT: an account-level fact (subscription, daily cap, the **Send breaker**) is the release poller's to decide (#900), never an item here."

And line 6: "`applyDispatchGate` — PURE. The single owner of amendment B6's seven-item ORDER". Line 750 restates it directly: "the gate is locked at seven items by B6/B14". `grep` confirms "seven" appears at lines 6, 13, 134, 225, 502, 750, 1596 — consistent usage throughout the file, not an isolated comment. The triage's factual claims about the Dispatch gate's scope and locked item count are accurate.

## Fix-introduced defects

None found (≥80% confidence). `pnpm typecheck` clean. The `release-phases.ts` extraction (F-Q3) is a straightforward hoist with a stated cycle-avoidance rationale (anchor lives in `auto-approval.ts`, which `release.ts` imports, so the shared seam had to move to a third module rather than either importing the other); `isolateItem`'s new `phase` first argument is threaded correctly at the one call site in `auto-approval.ts` (`isolateItem('veto_anchor', ...)`). Live-DB anchor test suite (5/5) and the non-retroactivity test (1/1) both pass against the actual fix.

## Appendix — unrelated observations (no new fronts)

- F-Q4 (`readAccountWideSuspension` single-owner extraction) and F-Q7 (`solicitation-settings.ts` split) were skimmed only for collateral damage to A2/A4/A1; not independently re-verified beyond typecheck passing, per scope.
- `pnpm ci:tenant-scope` output is a single summary line (no per-entry diff shown); the byte-for-byte match was confirmed by direct comparison of the allowlist's `VETO_ANCHOR_SCAN_SQL` constant against `selectAnchorCandidates`'s and `anchorOneBatch`'s actual SQL in the commit diff, not by re-deriving the audit's internal string-matching logic.

---

**A2: RESOLVED** — `failed_at IS NULL` in both anchor sites, comment states semantic, test extended, allowlist refreshed, `ci:tenant-scope` passes.
**A4: RESOLVED** — non-retroactivity test comment states the decision-at-finale lock.
**A1-basis: CONFIRMED** — dispatch.ts header verbatim locks the Dispatch gate at seven items (B6/B14) and assigns account-level facts to the release poller (#900).

No fix-introduced defect found.

**AXIS VERDICT: APPROVED**
