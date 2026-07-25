# Postmortem: #543 post-gate contract restart

## Trigger

The first implementation gate was green at `cc48de5e`, but the mandatory
adversarial review found four high-confidence no-ship gaps. Addressing the
health-alert gap requires a second allowed-surface amendment, so the feature
workflow's abort criterion requires a postmortem and a restart from intent
locking rather than another unrecorded patch round.

## What the original contract missed

1. **Tenant-safe meant query-scoped, not database-enforced.** Migration 088
   used single-column run foreign keys even though the intake required every
   new relationship to be tenant-safe. The amended contract makes the
   account, Business, and run identity part of both foreign keys and preserves
   archival by nulling only the run-id column.
2. **The gate list was incomplete.** The plan named feature flag and
   subscription entitlement but did not require the shared account-offboarding
   processing gate. A dispatched job could therefore race `delete_data`.
3. **Alerting was assumed, not traced.** The plan relied on "existing
   failed-topic health checks" without verifying that
   `build_solicitation_batch` was one of the queried topics.
4. **The result bound was mistaken for a work bound.** `LIMIT 5000` bounded
   output rows but did not prevent the visit-by-ask history multiplication
   before grouping. The amended invariant requires independently reducing
   each history to one row per Business/contact before joining.

## Restart decisions

- Keep the locked whole-eligible-pool candidate definition and 5,000-contact
  result bound.
- Keep priorBatch/contact-history limited to would-have-sent
  (`status='send'`) inclusions; `velocity_banked` remains excluded.
- Keep migration 088 unapplied to staging and production, and keep issue #546
  out of flight.
- Add four verbatim regression promises covering tenant FK rejection,
  offboarding race closure, failed-topic alerting, and bounded history work.
- Expand implementation surface only for the existing health-alert check and
  its focused unit test; review artifacts receive their required durable
  directory.

## Prevention

Future worker intake reviews must distinguish database-enforced tenancy from
query scoping, enumerate all shared processing gates, verify each promised
observability path by topic, and state both result-set and intermediate-work
bounds for history queries.
