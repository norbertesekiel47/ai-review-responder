# Runbook — Testing Auto-Approval on Staging

Tests the auto-approval feature end-to-end (design spec
`docs/superpowers/specs/2026-05-31-auto-approval-design.md`, phases 0–3) on the
**staging** full-stack environment.

> **Safety posture.** The feature ships **flag-OFF** — nothing auto-posts until you
> flip flags. Staging uses test/sandbox creds and a **separate Supabase**, so blast
> radius is contained. But once enabled, auto-approval **posts real replies to
> whichever Google Business Profile the staging Zernio sandbox is connected to** —
> treat every "auto-post" step as a real post to that test GBP. **Leave staging
> flag-OFF when you're done (§9).**

Only **`live_ingest_new`** (a first-time, brand-new live-ingest review) is
auto-eligible. Backfill/import, regenerate, and review-updates are always manual.

---

## 1. Flags to set — on BOTH surfaces

The flags are read in two different places: the **settings route runs on Vercel**
(Next.js) and the **runtime auto-decision runs on the Railway worker**. Set them in
both, scoped to the **staging** environment.

| Flag | Read by | Set to | Purpose |
|---|---|---|---|
| `AUTO_APPROVAL_ENABLED` | Railway worker **and** Vercel staging | `true` | Runtime auto-posting switch + settings readiness |
| `OPENAI_MODERATION_ENABLED` | Railway worker **and** Vercel staging | `true` | Provider moderation (mandatory for auto) |
| `AUTO_APPROVAL_PROVIDER_MODERATION_READY` | Vercel staging | `true` | Gates **settings expansion** only (not runtime) |
| `VERCEL_TARGET_ENV` | Vercel (auto-injected) | n/a — auto | Only genuine per-PR previews (`preview`) block expansion; the staging custom env is `staging`, so it's allowed |

- **Railway** → staging worker service → *Variables* → set `AUTO_APPROVAL_ENABLED=true`,
  `OPENAI_MODERATION_ENABLED=true` → redeploy. (The worker rejects any value that
  isn't exactly `true`/`false` at boot.)
- **Vercel** → the **staging** Custom Environment → *Settings → Environment Variables*
  (scoped to staging) → set the three flags → redeploy staging.
- **Provider moderation must actually run.** A draft only auto-approves when the
  per-draft provider verdict is `clean`. The staging worker therefore needs a working
  `OPENAI_API_KEY` and `MOCK_EXTERNAL_APIS` **false**. With moderation enabled but no
  clean verdict (error, disabled, or any flag), the draft falls back to **manual** —
  this is by design (moderation is an absolute veto).

Full per-var matrix: `docs/runbooks/deployment-guide.md` §II.3. Flag definitions:
`.claude/reference/env-vars.md`.

---

## 2. Confirm readiness (self-diagnostic) — do this first

Log into your staging URL as an **owner** (real session, not admin view-as) and open:

```text
https://<your-staging-host>/settings/auto-approval
```

The page renders a **readiness block**. Expansion controls (turning auto on / making
it broader) are enabled only when `canExpand` is true (no block reasons). If you see a
reason, fix it before continuing:

| UI copy | Cause | Fix |
|---|---|---|
| Auto-approval is not enabled for this environment | `AUTO_APPROVAL_ENABLED` ≠ true on **Vercel** | set it, redeploy staging |
| Provider moderation is not enabled | `OPENAI_MODERATION_ENABLED` ≠ true on **Vercel** | set it, redeploy |
| Provider moderation readiness has not been validated | `AUTO_APPROVAL_PROVIDER_MODERATION_READY` ≠ true | set it, redeploy |
| Preview environments cannot expand auto-approval | you're on a genuine per-PR **preview** deploy (`VERCEL_TARGET_ENV=preview`), not staging | use the staging deploy (`VERCEL_TARGET_ENV=staging`), where this is not blocked |
| The account cannot expand automation while billing is read-only | test account not active / in grace | use an active-subscription account |
| View-as sessions cannot change auto-approval | you're impersonating | use a real owner login |

You can also inspect the raw block: `GET /api/settings/auto-approval` (as the owner,
same-origin) returns `{ accountDefault, locations, readiness:{ canExpand, blockReasons … } }`.
It returns **derived booleans only** — never raw env names/values — and is `no-store`.

---

## 3. Settings tests (spec §12 / §17)

On `/settings/auto-approval`:

1. **Account default.** Dropdown: *Off/manual · 5-star only · 4-5 · 3-5 · 2-5 · All rated*.
   - Set e.g. **5-star only** → an expansion → a **confirmation modal** appears. Confirm it.
   - Set **All rated** (threshold 1) → modal shows the **stronger** warning (every rated
     review, including 1- and 2-star, can auto-post). Verify that copy.
2. **Per-location override.** Each active location can *Inherit account default* /
   pick its own threshold / *manual*.
   - Set an override → the row's **Effective** and source flip to "Location override".
   - Choose *Inherit* (delete the override) → if it inherits an **auto** account default,
     that's an expansion → confirmation required.
3. **Contractions always work.** Turning a policy **Off/manual** or more conservative
   must succeed even when readiness is blocked. Test: temporarily set
   `AUTO_APPROVAL_ENABLED=false` on Vercel → the expansion controls disable with reasons,
   but you can still set things to Off/manual (no confirmation). Restore the flag after.
4. **Negative paths (server-enforced):**
   - Expansion without confirmation → **400** `auto_approval_confirmation_required`.
   - Expansion while readiness blocked → **409** `auto_approval_expansion_blocked` (+ `blockReasons`).
   - A `locationId` not on your account → rejected (the route derives `accountId` from
     your session; it never accepts one from the request).
5. Every change writes one `account_audit_log` row, `event_type='auto_approval_policy_changed'`
   (verify in Supabase — see §8).

---

## 4. Happy path — a review auto-posts (spec §4)

All of these must hold at **response-persistence time** for a draft to auto-approve:

- review arrived as a **first-time new live-ingest** review (`origin_lane='live_ingest_new'`),
- current star rating **meets** the effective threshold for that location,
- provider moderation **clean** (enabled + `providerStatus='clean'`, not flagged, not held),
- **active Zernio connection** and **active (non-archived) location**,
- account subscription publishable (active / past-due-in-grace),
- `AUTO_APPROVAL_ENABLED=true` on the worker.

Steps:

1. Set the account default (or the test location's override) so the test review's star
   qualifies — e.g. policy **All rated** and any rated review, or **5-star only** + a 5★ review.
2. Generate a **new live-ingest review** for the connected staging GBP location (via the
   staging Zernio sandbox — a genuinely new review, **not** a backfill/import and **not** a
   regenerate of an existing one).
3. Tail the Railway staging worker logs: `ResponseGeneratorWorker` drafts → moderation →
   `persistResponseAndNotify` re-reads current state and evaluates the predicate → auto
   branch sets `status='approved'`, `approval_method='auto_policy'`, enqueues
   `publish_response` (and **no** `send_notification`) → `ResponsePublisherWorker` posts to Google.
4. **Verify:**
   - **No** owner approval notification/email for this review.
   - `responses` row → `status` reaches `posted`, `approval_method='auto_policy'`, `approved_text` set.
   - one `approval_audit_log` row → `action='auto_approved_by_policy'`, `auth_method='auto_policy'`,
     no token/user actor.
   - UI badge: **"Auto-approved"** on the Past Replies card / **"Auto"** in the dashboard feed —
     keyed on `approval_method`, not status.

---

## 5. Manual-fallback matrix (spec §4 / §17)

Each case below must end **`status='pending_approval'`, `approval_method IS NULL`**, with
normal owner notification (unless held) and **no publish**. The worker emits a sanitized,
low-cardinality log reason (no review/response text):

| Make it fail this gate | Expected log reason (representative) |
|---|---|
| Star below threshold (policy 5-star only, a 4★ review) | rating-below-threshold |
| No policy / policy Off | policy not eligible |
| Not `live_ingest_new` (review update / regenerate / backfill) | bad lane / manual |
| `AUTO_APPROVAL_ENABLED=false` on the worker | `auto_approval_disabled` |
| `OPENAI_MODERATION_ENABLED=false` | `provider_moderation_disabled` |
| Provider returns an error | `provider_moderation_error` |
| Archived location at persist | archived-location fallback |
| No active Zernio connection at persist | `active_zernio_connection_missing` |
| `pending_payment` / cancelled subscription | `publisher_subscription_denied` |
| **High-severity moderation flag** | **held** — no notification, `flagged_responses` row (admin-only); **never auto-approved** |

Spot-check 3–4 of these. The high-severity-flag case is the important safety one:
confirm a flagged draft is **held** and does **not** auto-post (moderation is an absolute veto).

---

## 6. Kill-switch downgrade (spec §10)

1. Get an auto-policy row to **`approved` but not yet posted** (catch one in-flight, or
   briefly pause the publisher), then flip **`AUTO_APPROVAL_ENABLED=false`** on the worker.
2. Before any external post, `ResponsePublisherWorker` downgrades the row:
   `status='pending_approval'`, `approval_method=NULL`, `approved_text=NULL`,
   `approved_at=NULL`, `posting_error='auto_policy_revoked_by_kill_switch'`, and enqueues a
   normal `send_notification`.
3. **Verify:** row back to manual review, owner notified, one `approval_audit_log` row
   `action='auto_policy_revoked_by_kill_switch'`, **`response_text` preserved**. Manually
   approving afterward sets `approval_method='owner'` and clears the `posting_error`.
4. Expected: flipping the switch off with many in-flight auto rows produces a notification
   **burst** — that's the safe direction, by design.

---

## 7. Admin read-only diagnostics (spec §11)

As an admin, open:

```text
https://<your-staging-host>/admin/businesses/<businessId>
```

The **Auto-approval diagnostics** panel shows: current account default + per-location
effective policy, derived runtime/provider readiness (`canExpand` + reasons), recent
auto-approval audit decisions and kill-switch downgrades, and the `approval_method`
badge. It is **read-only** (no controls — admin mutation is out of scope in v1).

---

## 8. Supabase verification queries (staging project)

```sql
-- effective policy rows for the account
select account_id, location_id, auto_approve_min_star, updated_at
from auto_approval_policies where account_id = '<account-uuid>';

-- a review's response attribution across versions
select id, version, status, approval_method, approved_at, posting_error
from responses where review_id = '<review-uuid>' order by version;

-- the auto / downgrade audit trail for a response
select action, auth_method, metadata, created_at
from approval_audit_log where response_id = '<response-uuid>' order by created_at;

-- settings-change audit
select event_type, payload, created_at
from account_audit_log
where account_id = '<account-uuid>' and event_type = 'auto_approval_policy_changed'
order by created_at desc;
```

---

## 9. Revert — leave staging flag-OFF

1. Set `AUTO_APPROVAL_ENABLED=false` on **both** the Railway worker and Vercel staging; redeploy.
2. (Optional) set the test account/location policies back to **Off/manual**.
3. Reload `/settings/auto-approval` → the readiness block should again show auto disabled.

---

## Appendix — isolating the runtime from the settings gate

If you want to test only the **runtime** auto-decision without satisfying the settings
expansion gate (e.g. provider-readiness flag unset), you can seed a policy row directly in
the staging Supabase instead of using the UI:

```sql
insert into auto_approval_policies (id, account_id, location_id, auto_approve_min_star)
values (gen_random_uuid(), '<account-uuid>', null, 1);  -- account default = All rated
```

Then proceed from §4. (The UI path in §3 is the proper test of the settings layer; this
shortcut is only for isolating the worker predicate.)
