# Staging ride — `fix-697-import-consent-analytics-sink`

**Date:** 2026-08-08 · **Commit on `staging`:** `1ad175a3..1cb5dc24` (fast-forward)
**Lane:** RISK = high, so `staging` first per `/feature` step 8.

## Why a synthetic proof

The change only shows itself when an analytics emission FAILS. Staging has
migration 102 applied, so the failure never happens naturally there. The two
honest options were to drop `analytics_events_event_name_check` on staging (a
destructive DDL on a shared database, with a restore step that can be missed) or
to induce the same SQLSTATE without changing the schema. The second was chosen —
same table, same constraint, same `23514`, reached by offering the constraint a
name it rejects.

## What was run

`.feature/staging-sink-proof.ts` (gitignored, dies with the worktree — reproduced
in full at the bottom of this file). It:

1. Initializes `@sentry/node` with the **staging worker's own `SENTRY_DSN`**.
2. Connects to the **staging Supabase** pool.
3. Opens ONE transaction and, inside it, puts a real staging business into the
   offerable shape, calls the real `createImportOffer` through the same
   `failingEmission` proxy the integration suite uses, then issues a statement
   AFTER the failed emission on the caller's own handle.
4. Throws to abort that transaction, so **nothing persists**.

## Result

```
{"offer_outcome":"created","caller_survived_the_failed_emission":true}
{"sentry_flushed":true}
{"business_import_decision_after":"accepted","business_offer_deadline_still_set":true,"poison_rows_left_behind":0}
```

Plus the stdout sink, emitted with the real Postgres error:

```json
{"level":"warn","logger":"import-consent","message":"Import consent analytics emission failed",
 "data":{"business_id":"019fd299-…","event_name":"import_offer_created",
 "error":"new row for relation \"analytics_events\" violates check constraint \"analytics_events_event_name_check\""}}
```

`offer_outcome: "created"` is the load-bearing line — it means the emitting
branch actually ran, so the capture below is the production path and not a
hand-rolled call.

## The Sentry issue

`REPWORTH-STAGING-S` — https://repworth-nv.sentry.io/issues/REPWORTH-STAGING-S

| field | value |
|---|---|
| title | `Import consent analytics emission failed` |
| level | `warning` |
| `tags.subsystem` | **`import_consent_analytics`** ← what the alert rule routes on |
| `tags.event_name` | `import_offer_created` |
| `tags.environment` | `staging` |
| `extra` | exactly three keys — `business_id`, `event_name`, `error`. No review text, no tokens, no handles, not the event `properties`. |

Resolved immediately after capture, with a comment on the activity feed
explaining that it is synthetic (`tags.proof = issue-697-staging-ride`).

## What this proves, and what it does NOT

**Proves:** the production code path reaches a real Sentry project and lands an
issue carrying the tag an operator needs to build the routing rule — i.e. the
deliverable of #697 exists as a thing that can be configured, not just as a
function call. Also proves the caller survives a failed emission against the
real staging database (`caller_survived_the_failed_emission: true`), which is the
#679 connect-outage regression.

**Does NOT prove:** that the capture originates from inside the Railway worker or
the Vercel Next server — the proof ran from a developer machine
(`server_name: Norberts-MacBook-Pro.local` on the event). That gap is covered by
every other capture site in the codebase, which already demonstrates Sentry is
initialized in both runtimes (`worker/sentry.ts`, `src/instrumentation.ts`), and
by the two staging deploys of this commit going green (Railway `repworth-worker`
and Vercel, both `pass` on PR #708).

## The script

Kept here because `.feature/` is gitignored and is deleted with the worktree.

```ts
// Init: Sentry.init({ dsn: STAGING_SENTRY_DSN, environment: 'staging' })
//       Sentry.setTag('proof', 'issue-697-staging-ride')
// Poison: an INSERT INTO analytics_events whose event_name is
//         'import_consent_emission_poison' — a name the live CHECK rejects.
// Proxy: identical in shape to `failingEmission` in
//        src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts
//        (wraps `savepoint` explicitly; poisons ONLY the emission statement).
await sql.begin(async (tx) => {
  await tx`UPDATE businesses
           SET import_decision = 'pending', import_offer_expires_at = NULL,
               import_decision_at = NULL
           WHERE id = ${BUSINESS_ID}::uuid`;            // rolled back
  outcome = await createImportOffer(failingEmission(tx), BUSINESS_ID, ACCOUNT_ID);
  await tx`SELECT 1 FROM businesses WHERE id = ${BUSINESS_ID}::uuid`;  // 25P02 here = outage
  postEmissionSurvived = true;
  throw ROLLBACK;                                        // nothing persists
});
```
