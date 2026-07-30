# PENDING — F3 / F4 / F5: the migration-091 amendment this session could not land

**Status: NOT APPLIED.** Blocked by `migration-immutability-guard.sh`, which reads
`MIGRATION_GUARD_DISABLE` from the session environment — it cannot be set mid-session, and
`bash-write-guard.sh` correctly closes the `sed -i` back door. **Relaunch with
`MIGRATION_GUARD_DISABLE=1` to apply this.**

## Why this amends 091 rather than adding 092

Migration 091 has **never been applied outside the local test DB**. Staging and prod are both at
**090** (`.claude/reference/migrations-log.md`; the handoff records the same). Amending in place is
therefore correct and a corrective 092 would be *wrong* — it would ship two migrations describing
one never-deployed schema.

The guard fires only because T1 bumped `migrations-log.md` to head 091 in the same commit as the
migration (the documented convention), which makes an unapplied file look applied. The guard's own
header names this exact false positive and sanctions the escape hatch for it.

**After applying: re-provision and re-verify, in this order.**

```
pnpm test:db:setup        # serially, NEVER as a gate row — see deviations entry 16
export TEST_DATABASE_POOL_URL="$(grep -m1 '^TEST_DATABASE_POOL_URL=' .env.local | cut -d= -f2- | tr -d '"')"
pnpm test src/lib/shared/__tests__/migration-091-send-mode-spine.integration.test.ts
pnpm test src/lib/solicitation/__tests__ worker/background/pollers/__tests__
bash scripts/verify-gate.sh
```

---

## F3 — `solicitation_batches`: the transition graph is not enforced

**Current** (`091:146-159`) enforces only three things:

```sql
sending_started_at IS NULL OR approved_at IS NOT NULL
sending_started_at IS NULL OR sending_started_at >= approved_at
send_closed_at     IS NULL OR built_at     IS NOT NULL
```

**Legal today, and shouldn't be:** `approved_at` set with `built_at IS NULL` (an approved batch
whose content does not exist); `approved_at < built_at`; an orphan `veto_deadline_at` with no
approval; `send_closed_at` or `halted_at` earlier than the events they close.

The first is the dangerous one: the `solicitation_batches_one_active_send_per_business` partial
unique index keys on `approved_at IS NOT NULL AND send_closed_at IS NULL AND halted_at IS NULL`, so
an approved-but-unbuilt batch **enters the live-send index**, and `deriveBatchState` reports it
`approved` because precedence puts `approved` above `built`.

**Keep** the deliberate omission of "closed implies approved" — `generation_failed` and B7 expiry
both close never-approved batches, and the migration's existing comment reasons this correctly.

Replace the constraint with (note every arm stays `IS TRUE`-wrapped per this migration's idiom,
because a CHECK accepts NULL):

```sql
ALTER TABLE solicitation_batches
  DROP CONSTRAINT IF EXISTS solicitation_batches_send_ordering;
ALTER TABLE solicitation_batches
  ADD CONSTRAINT solicitation_batches_send_ordering CHECK (
    (
      -- approval implies built content, and never precedes it
      (approved_at IS NULL OR built_at IS NOT NULL)
      AND (approved_at IS NULL OR approved_at >= built_at)
      -- the veto window is an artifact of approval
      AND (veto_deadline_at IS NULL OR approved_at IS NOT NULL)
      AND (veto_deadline_at IS NULL OR veto_deadline_at >= approved_at)
      -- sending implies approval, and never precedes it
      AND (sending_started_at IS NULL OR approved_at IS NOT NULL)
      AND (sending_started_at IS NULL OR sending_started_at >= approved_at)
      -- closure implies built (NOT approved: generation_failed and B7 expiry
      -- both close a batch that was never approved) and never precedes the
      -- events it closes
      AND (send_closed_at IS NULL OR built_at IS NOT NULL)
      AND (send_closed_at IS NULL OR send_closed_at >= built_at)
      AND (send_closed_at IS NULL OR approved_at IS NULL OR send_closed_at >= approved_at)
      AND (send_closed_at IS NULL OR sending_started_at IS NULL
           OR send_closed_at >= sending_started_at)
      -- the halt latch is monotone and cannot predate the build
      AND (halted_at IS NULL OR built_at IS NULL OR halted_at >= built_at)
    ) IS TRUE
  );
```

**Tests owed** (`migration-091-send-mode-spine.integration.test.ts`): one rejection case per new
arm, plus a positive case for the still-legal `closed-but-never-approved` shape so the carve-out
does not silently regress.

## F4 — `solicitation_outreach`: status and lifecycle timestamps can contradict

`solicitation_outreach_status_reason_consistency` couples status to `disposition_reason` only.
`solicitation_outreach_body_presence` does couple redaction to `sent_at` ("redaction means gone AND
sent"), so Codex's "constrained only against disposition_reason" is slightly overstated — but both
concrete holes are real:

1. **`delivery_status = 'sent'` with `sent_at IS NULL` is legal.** The redaction sweep selects on
   `sent_at < NOW() - 90 days`, so such a row is never a candidate and **keeps its body forever**.
2. **A live `rendered` row with a stale `sent_at` is legal, and the sweep will redact it.** T6's
   predicate filters `sent_at` and `body_redacted_at` only, never `delivery_status`. Redaction
   satisfies `body_presence` (redacted ⇒ `sent_at` present ✓) and yields a **bodyless live
   attempt** that can neither send nor settle — wedging its batch behind the one-live-per-ask index.

Constrain the data rather than filtering in the sweep: the sweep is not the only future reader.

```sql
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_status_timestamp_consistency;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_status_timestamp_consistency CHECK (
    (
      -- sent is the only status that carries sent_at, and it requires it
      (delivery_status = 'sent') = (sent_at IS NOT NULL)
      -- queued/sending/sent imply the preceding stamp, in order
      AND (sending_at IS NULL OR queued_at IS NOT NULL)
      AND (sending_at IS NULL OR sending_at >= queued_at)
      AND (sent_at IS NULL OR sending_at IS NULL OR sent_at >= sending_at)
      -- a live attempt has not been dispatched yet
      AND (delivery_status <> 'rendered' OR (queued_at IS NULL AND sending_at IS NULL))
      AND (delivery_status <> 'queued'   OR sending_at IS NULL)
    ) IS TRUE
  );
```

**Column names verified against the shipped migration:** `queued_at`, `sending_at` and `sent_at`
are all `TIMESTAMPTZ` on `solicitation_outreach` (`091:205-207`), so this patch applies as written.

Note `body_presence` already forbids redacting a row with no `sent_at`, so arm 1 closes hole 2 too:
once `sent_at` implies `delivery_status = 'sent'`, a `rendered` row cannot carry one.

**Tests owed:** `sent` requires `sent_at`; a non-`sent` status rejects `sent_at`; `rendered` rejects
`queued_at`/`sending_at`; the stamp ordering rejects each inversion.

## F5 — redaction leaves the source PII readable forever

`interpolation_inputs JSONB NOT NULL` (`091:185`) carries `contact_first_name` and `visit_note`
(`docs/superpowers/specs/2026-07-28-ask-generation-design.md:499-504`). The sweep nulls only
`rendered_subject` / `rendered_body` (`ArchivalPoller.ts:262`), so after 90 days we delete the
rendered sentence and keep the source it was rendered from. `CONTEXT.md`'s **Body redaction** entry
states the objective as data minimization on third-party PII — that objective is not met.

The column is `NOT NULL`, which is why this lands with the schema work rather than as a
poller-only change. **Two options — the map owner should pick:**

- **(a) Redact it with the body.** Add `interpolation_inputs = '{}'::jsonb` to the sweep's `SET`.
  Simplest, keeps `NOT NULL`, loses all reproducibility after 90 days.
- **(b) Split sensitive from reproducible.** Keep non-PII (template id, policy/prompt version,
  classification) and drop the PII members. Preserves audit value; needs a defined retained shape.

**(a) is the recommendation** — reproducibility past 90 days has no named consumer, and YAGNI plus
data minimization both point the same way. Whichever is chosen, the `ArchivalPoller` `SET` clause
changes, so **the `tenant-scope-allowlist.ts` entry's `sqlSnippet` must be updated in the same
change** (the audit matches SQL text exactly — this is a live tripwire).

**Tests owed:** extend T6's two promised redaction titles to assert `interpolation_inputs` no longer
carries the PII members after the sweep, and that a row inside the window keeps them.

---

## Ordering

F3 and F4 are one 091 amendment. F5's schema decision rides with them; its poller + allowlist edit
follows. Then re-provision, re-run the suites above, re-run the gate, and only then step 7 — its
spec agent would otherwise re-report these five findings as new.
