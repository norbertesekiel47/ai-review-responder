# #1189 — Close the two Admin API read gaps

Locked intent: issue #1189 and ADR 0027 D1–D2. Base is
`c951bc2ebbafba310cc35f11f6e06fc5d8b57414`, including merged #1185.
Size small; risk high (admin authorization and tenant-scoped read); backend.

## T1 — Sequential business detail and batch summary

Keep the canonical `requireAdminWithAal2` gate and existing error responses.
After `getBusinessDetail(sql, businessId)` resolves and its missing-business
check passes, call `readAdminBatchSummary(sql, detail.account.id, businessId)`.
Return `{ ...detail, batchSummary }`. The batch reader owns ordering and safe
projection. No new query, no Promise combinator, and channels stays separate.
Precedent: `src/app/admin/businesses/[id]/page.tsx`.

Test seam: exported GET with real batch reader and a controlled SQL adapter;
existing gate tests continue exercising the canonical gate. A deferred detail
promise proves no batch read starts early, then asserts exact response equality
with `{ ...detailFixture, batchSummary: expectedSummary }`, preserving representative
existing fields. Scope fixtures make a batch exist
only for one account/business pair; wrong account and wrong business return
null. Missing business must skip the batch read; a failed batch read must use
the existing generic 500. The existing two success fixtures gain account.id,
as the real detail DTO already contains it. Tests are red before production
edits. Allowed files: the detail route and its two named test files.

## T2 — Server-authoritative business options

After T1 establishes the route precedent, add GET businesses/options using
`requireAdminWithAal2`, returning only
`{ betaCompActive: betaCompCouponId() !== null }` with dynamic rendering.
Precedent: `src/app/admin/businesses/new/page.tsx` and adjacent gated GETs.
No coupon id, env twin, page edit, or generalized option registry.

Test seam: exported GET, real canonical gate using the existing shared identity
mock helper, real coupon accessor with test-only env values. Cover armed and
unarmed cookie responses, bearer success, and AAL1/non-admin/unauthenticated
refusals (including no-store and no data access). Tests precede production code.
Allowed files: options route and its named test file.

## T3 — Evidence and delivery

Update `docs/directory/app-api-b.md` and append the architecture review trace.
Surface amendment 1 corrects the admin rule's stale app-api-a pointer; the
directory index and actual admin table identify app-api-b as the owner.
The existing
admin gate audit discovers new routes; edit no audit unless source proves a
required change (that would be a surface amendment). Run focused tests,
ci:admin-aal2, ci:pool-fanout, tenant/RLS audits, then the full review gate with
SENTRY_AUTH_TOKEN empty and one Vitest worker. No source-map upload.

Fresh read-only plan skeptic precedes implementation. Once gate-green, freeze
the committed SHA and run independent correctness, maintainability, security
reviews plus the high-risk adversarial verifier. Reviewers stage prose outside
git and read committed blobs while the verifier alone mutates. With the four
active-agent slot ceiling, distinct fresh review axes are scheduled as slots
free in the same frozen-SHA wave. The lead runs the finalizer and preserves all
verbatim axis reports, IDs, SHAs and hashes in separated findings.md appendices,
then commits the two findings artifacts and regenerates the full fingerprint.
The staged originals and transcript attachments remain available locally.

Artifact formatting adaptation, approved by the orchestrator: feature skill
section 6.5 requests copying staged reports to docs/reviews/<branch>, while
red-team-status.mjs's staleness check exempts only this run's findings.md/json.
Embedding complete reports in findings.md preserves durable independent review
without changing that checker or invalidating measured source for a prose-only
copy. All findings and triage remain present; any source fix still requires
fresh measurement.

Inventory is complete in both directions: changed test cases and cases covering
changed production hunks. Existing PATCH-only cases do not execute the changed
GET hunk; record that scope decision explicitly rather than silently sampling.
The default 30-launch runner budget can cover only 15 individual baseline/mutant
pairs. Resolve the measured inventory capacity with the owner before mutation
execution; do not reuse #1185's exception or reduce legitimate coverage.

Staging first, pinned to the reviewed runtime commit. Root operates the in-app
browser using the existing staging admin: verify the exact options JSON and
business detail's batchSummary using designated staging data, plus legacy
business screen regression at desktop/mobile. Collect sanitized evidence without
secrets or customer data. If fresh authentication is required, the owner enters
it directly. No new admin, flag, migration or production write.

Open the PR, obtain CI green, and stop for owner merge approval. After a later
explicit merge approval, ticket resolution records PR, staging evidence and
merge SHA, followed by staging realignment. #1190 waits for this merge.

Rollback: revert this ticket through an approved PR; no schema or durable state
changes. Legacy pages retain their original direct reads throughout.
