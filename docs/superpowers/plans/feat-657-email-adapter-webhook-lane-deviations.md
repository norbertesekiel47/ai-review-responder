# feat-657 — deviations

Entries the plan did not anticipate. Every entry gets a one-line ACCEPT / RE-PLAN
verdict at step 6 before review agents see this file.

---

## D1 — Plan review round 1 (Codex, 2026-08-16)

**Session id:** `01a00d4d-6fa7-72e3-b275-583f8a89dc99`
**Verdict returned:** `REVISE`. Eight findings, three citation errors. **All accepted.**
Full output: `scratchpad/657-plan-review-round1.txt` (not committed — findings are
transcribed below in full, so nothing of value lives only there).

### Citation errors — all three verified independently against the repo

| # | Claim | Verified | Fix |
|---|---|---|---|
| C1 | `solicitation_contacts` has no `normalized_handle` column | **TRUE.** Migration 086 defines `email TEXT` with the comment "Normalized handle: lowercased/trimmed". The planned attribution query would have thrown at runtime on every solicitation webhook event. | Query `c.email AS normalized_handle`. Task 6 Step 4 rewritten. |
| C2 | `NotificationFailoverPoller.integration.test.ts` does not use `acquireLiveDbLock` | **TRUE.** | Precedent re-cited as `src/lib/solicitation/__tests__/owner-do-not-contact.integration.test.ts` — a solicitation live-DB suite using both `acquireLiveDbLock` and `assertSchemaReady`. |
| C3 | The deviations file the plan tells Task 1 to write did not exist | **TRUE.** | This file. Added to the plan's Create table. |

C1 is exactly the failure the cited-artifact check exists to catch: a plan that
reads correct and fails on first execution.

### Findings

| # | Sev | Finding | Verdict | Fix |
|---|---|---|---|---|
| F1 | critical | A bounce arriving before `#630` commits `provider_message_id` is warned-and-acked, permanently losing a hard bounce or complaint | **ACCEPT** | Suppression-bearing events (hard bounce, complaint, provider-suppressed) now **throw** on unmatched attribution → 503 → Resend retries. Bounded for free by the existing 300s stale-`svix-timestamp` window: a retry beyond it is 401'd, so a genuinely-unknown id cannot retry forever. Non-suppression-bearing events (soft bounce, `email.failed`) keep §5.1's warn-and-ack. |
| F2 | high | Attribution is read outside the transaction; the row can be deleted before the `UPDATE`, which then affects 0 rows while the suppression still commits | **ACCEPT** | Lookup moves **inside** `sql.begin` with `FOR UPDATE OF o`, and the `UPDATE` asserts it affected exactly one row. Note the house gotcha: `FOR UPDATE` is a no-op outside `sql.begin()` under PgBouncer transaction pooling. |
| F3 | high | No unique index on `provider_message_id`; `LIMIT 1` silently mutates an arbitrary row when two match | **ACCEPT** | Fetch `LIMIT 2`. Two rows is an impossible state — throw with context rather than branch. |
| F4 | high | `getSolicitationResend()` caches its client, so the intake's "unset the key to stop sends" rollback is false at runtime | **ACCEPT, reframed** | No code change — `getResend()` caches too and Railway restarts the worker on any env change. The **intake's `rollback_plan` was wrong** and is corrected in both copies. The test documents the real contract (cached; a key change needs a restart) rather than asserting a behaviour we are not building. |
| F5 | high | `ownerEmail` reaches `replyTo` with no CRLF guard — header injection | **ACCEPT** | Added to `assertSendable`. |
| F6 | high | Both Resend tag shapes are promised but only one is forced by a test | **ACCEPT** | Added an object-map routing test alongside the array-shape one. |
| F7 | medium | `to: [recipient]` with `'a@x, b@y'` may reach two mailboxes — the one-recipient rule is not actually enforced | **ACCEPT** | `assertSendable` rejects a recipient containing a comma or internal whitespace. |
| F8 | medium | Provider-controlled bounce/failure reason text is carried into structured logs and may contain an address | **ACCEPT** | The lane logs the classified **kind** (`hard`/`soft`) and never the raw provider string. The full classified value still lands in `provider_error`, which is a column, not a log. |

### Tests added beyond the intake's `tests_to_add`

Owner-approved additions, not retitles. `promised-tests` checks that every promised
title exists, so extras are free. Eight from planning and this review round:

1. `the email adapter strips CR and LF from the From display name`
2. `the email adapter escapes a double quote in the From display name`
3. `the email adapter rejects a recipient containing CR or LF`
4. `the email adapter rejects a subject containing CR or LF`
5. `the email adapter rejects a Reply-To value containing CR or LF` (F5)
6. `the email adapter rejects a comma-separated recipient value rather than allowing more than one mailbox` (F7)
7. `the resend webhook routes a solicitation payload whose tags are an object map to the solicitation lane` (F6)
8. `the solicitation lane retries rather than acknowledging an unmatched suppression-bearing event` (F1)
9. `the solicitation lane writes nothing when its attributed outreach row is removed mid-transaction` (F2)
10. `the solicitation lane refuses an ambiguous provider message id without mutating an arbitrary outreach row` (F3)
11. `the solicitation lane never logs a raw provider bounce or failure reason` (F8)

### Intake corrections (deviations-file entries, NOT surface amendments)

- **`rollback_plan`** — the runtime back-out sentence was wrong (F4). Corrected in
  both `docs/superpowers/plans/feat-657-email-adapter-webhook-lane-intake.json` and
  `.feature/intake.json` to say the worker must restart, which Railway does on any
  env change.

`allowed_edit_surface` is **unchanged**. Amendment count remains **0**.

---

## D2 — Secondary note accepted from round 1

Codex observed that the plan's Architecture line ("config + boot assert gate the
lane's existence") is not true of the ingress: per glossary rule **DR1**,
`SOLICITATION_SEND_ENABLED` masters *sending* only — the webhook lane, the
unsubscribe ingress and the landing page stay fully live when it is off. The
Architecture paragraph is corrected to say so. **ACCEPT** — wording only, no
behaviour change, but the wrong version would have invited a reviewer to add a
flag gate the ledger must not have.
