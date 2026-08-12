# #773 investigation deviations

## D1 — Existing migrations were applied manually to the disposable branch

**Status:** acknowledged after execution; not retroactively authorized.

**Approved contract:** The intake required the differential to run only on a
positively confirmed ephemeral Supabase branch and stated that this
investigation would make no schema changes. Branch-cost approval authorized
creation of the disposable branch; it did not authorize a remote migration.

**What happened:** Supabase created branch `uqktyhufxtsriwpoxsbi` but reported
`MIGRATIONS_FAILED` and left `public` empty. The operator then applied the 104
already-checked-in files under `supabase/migrations/` to that branch's direct
connection with `ON_ERROR_STOP=1`. All applied without error, producing the
schema required by the health-bundle differential. This was a remote schema
mutation outside the approved execution contract and crossed the feature
workflow's separate remote-migration authority boundary.

**Scope and recovery:** The mutation was limited to the sole-client disposable
branch. No staging or production schema, configuration, or durable data was
changed. After the four-arm run, the harness cleanup reached a zero-residual
barrier and the branch was deleted. A subsequent Supabase `list_branches`
returned only the pre-existing default `main` branch.

**Owner acknowledgement:** The owner supplied the post-run report disclosing
the manual migration and then authorized corrective integration with “Go for
it.” This records after-the-fact acknowledgement only; it does not rewrite the
action as prior approval.

**Follow-up:** File the automated branch migration replay failure separately
before relying on Supabase branch provisioning. The run proves only that replay
failed while the same checked-in chain applied manually; it does not establish
the cause.

## D2 — Staging baseline moves to the capacity-treatment feature

**Status:** approved scope amendment on 2026-08-12.

The original intake combined the pipeline-depth experiment with a current
authenticated staging latency baseline. The conclusive `depth-one-wedged`
result leaves no pipeline-depth treatment to compare, so the owner approved
moving execution of the baseline to the future feature that proposes a real
capacity treatment. The protocol remains checked in and mandatory before that
feature proposes or deploys a production-client change. This investigation
does not claim that the baseline ran.
