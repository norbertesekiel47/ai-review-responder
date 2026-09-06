---
paths:
  - "src/lib/reviews/**"
  - "worker/jobs/zernio/**"
  - "worker/ingress/zernio/**"
  - "src/app/api/dashboard/import-offer/**"
  - "src/app/api/dashboard/reviews/**"
---

# Reviews and import rules

## Read first

- Review ingestion / adding a ReviewSource: `.claude/reference/review-ingestion.md` (enqueue paths live there).
- Review import consent (the Import offer, `import_decision`, the derived-expiry predicate, the four enqueue gates): spec `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` (§2 D1–D10 **locked**) + ADRs `docs/adr/0015-consented-import-unflagged-replacement.md` / `docs/adr/0016-import-consent-enforcement-locus.md` + `docs/context/core-reviews-responses.md` → **Review import**, **Import consent**, **Import offer**, **Import window**, **Live-ingest cutoff** (LOCKED).
- Rules + why: `docs/directory/lib-reviews-responses.md` § `reviews/`; zernio jobs in `docs/directory/worker-jobs-*.md`; `docs/directory/worker-ingress.md` (zernio/).
- Lab notes: `.claude/reference/lab-notes/zernio.md` (nested `account.id`, `MOCK_EXTERNAL_APIS` real-path tests, the non-descending sandbox feed).
- Invariant #7 (ReviewSource contract: everything normalizes to `NormalizedReview`) stays in `.claude/CLAUDE.md`; review sentiment (`classifySentiment`) is documented in `.claude/CLAUDE.md` § Database.

## Traps

Review import consent:

- (a) `src/lib/reviews/import-consent.ts` owns the predicate and every consent write incl. `enqueueInitialImport` — never re-spell its guard; (b) `guardImportConsent` (`worker/jobs/zernio/job-eligibility.ts`) is a fail-closed chokepoint, SEPARATE from `guardZernioJobEligibility`; (c) its body stays inside `sql.begin` + `FOR UPDATE`, or an owner's accept races it into silent data loss.

Zernio (moved from `.claude/CLAUDE.md` § Non-obvious gotchas):

- **Zernio `account.disconnected` payload** uses nested `account.id`, not flat `accountId`. Read `body.account?.id`.

## Rules

- Nothing beyond the traps was moved from `.claude/CLAUDE.md`.
