# WhatsApp Content Templates

This file is the authoritative reference for every WhatsApp template RepWorth submits to Meta via the Twilio Content API. The running code (`src/lib/notifications/channels/whatsapp-body.ts`) renders variables against the template shapes defined here; any shape change here requires a code change there and a fresh Meta review cycle.

## `repworth_approval_request_v1`

**Purpose:** Notify a business owner that a new review has arrived and a draft response is ready for approval. Sent outbound from RepWorth; receives button replies back via `/ingress/twilio/whatsapp-inbound`.

**Twilio Content type:** `whatsapp/card`

> **Why `whatsapp/card` not `twilio/card`:** `twilio/card` forces all WhatsApp message text into the `title` field — its `body` field is RCS-only — and constrains button-type mixing. Our approval template requires body text (up to 1024 chars, variable-interpolated) **plus** a mix of 2 QUICK_REPLY + 1 URL button. `whatsapp/card` provides a real `body` field (up to 1024 chars with `{{n}}` variables), optional `header_text` / `footer` (60 chars each), and supports mixed QUICK_REPLY (up to 10; 3 if sent in-session unapproved) + URL (max 2) buttons.

**Meta category:** UTILITY (transactional; not promotional)

**Body text:**

```
New ⭐{{3}} review for {{1}}

From: {{2}} · {{4}}

"{{5}}"

Draft reply:
{{6}}
```

**Variables:**

| Index | Content | Type | Max length | Null-safe default |
|-------|---------|------|------------|-------------------|
| 1 | Business name | string | 100 | — (always set) |
| 2 | Reviewer name | string | 100 | `"Reviewer"` if missing |
| 3 | Star rating | string `"1"`–`"5"` | 1 | — |
| 4 | Review date | string, short format e.g. `"Apr 18"` | 12 | — |
| 5 | Review text | string | 400 | `"(no comment)"` if null/empty |
| 6 | Response preview | string | 400 | — (always set by generator) |
| 7 | Approve button payload | string `"a:<uuid>"` | 64 | — |
| 8 | Regenerate button payload | string `"r:<uuid>"` | 64 | — |
| 9 | URL button suffix (raw approval token) | string | 64 | — |

**Buttons:**

| Index | Type | Label | Dynamic content |
|-------|------|-------|-----------------|
| 0 | QUICK_REPLY | Approve | `id` field = `{{7}}` (this `id` is what WhatsApp returns as the inbound button payload on tap) |
| 1 | QUICK_REPLY | Regenerate | `id` field = `{{8}}` (returned as inbound payload on tap) |
| 2 | URL | Edit / view full | `url` field = `https://app.repworth.com/approve/{{9}}` |

**URL button base:** `https://app.repworth.com/approve/` — Meta-approved at submission. Runtime assertion in `worker/config/startup-assert.ts::assertChannelsWhatsAppEnv` fails boot if `WHATSAPP_APPROVAL_URL_BASE` env var does not equal `NEXT_PUBLIC_APP_URL + '/approve/'`. Staging / local environments MUST use a different approved template SID (with their own URL base) or run flag-off.

### Variable map validation gate

**BEFORE submitting to Meta**, diff the template's `{{1}}`–`{{9}}` indices against `formatApprovalWhatsApp` in `src/lib/notifications/channels/whatsapp-body.ts`. The send code passes `contentVariables` positionally (keys `"1"`–`"9"`); there is no runtime re-mapping.

Canonical 9-variable map (source of truth is `formatApprovalWhatsApp`):

| Key | Code expression | Template placeholder |
|-----|----------------|----------------------|
| `"1"` | `params.businessName` | `{{1}}` in body |
| `"2"` | `params.reviewerName \|\| 'Reviewer'` | `{{2}}` in body |
| `"3"` | `String(params.starRating)` | `{{3}}` in body |
| `"4"` | `params.reviewDate` | `{{4}}` in body |
| `"5"` | `truncate(params.reviewText ?? '(no comment)', 400)` | `{{5}}` in body |
| `"6"` | `truncate(params.responsePreview, 400)` | `{{6}}` in body |
| `"7"` | `` `a:${params.approvalLinkId}` `` | `{{7}}` → Approve button `id` |
| `"8"` | `` `r:${params.approvalLinkId}` `` | `{{8}}` → Regenerate button `id` |
| `"9"` | `extractTokenFromApprovalUrl(params.approvalUrl)` | `{{9}}` → URL button suffix |

Any change to `formatApprovalWhatsApp` (add/remove/reorder variables) requires a matching template edit **and** a fresh Meta review cycle. Copy is locked only after this diff passes — see [Copy-lock note](#copy-lock-note) below.

#### Variable-map validation (2026-06-26)

Diffed the documented `repworth_approval_request_v1` body + button map against the live renderer `formatApprovalWhatsApp` (`src/lib/notifications/channels/whatsapp-body.ts:148-159`). Positional `contentVariables` keys `"1"`–`"9"` (no runtime re-mapping):

| Index | Renderer source field (`formatApprovalWhatsApp`) | Template placeholder |
|-------|--------------------------------------------------|----------------------|
| 1 | `truncate(oneLine(params.businessName), 100)` | `{{1}}` body — business name |
| 2 | `truncate(oneLine(params.reviewerName \|\| 'Reviewer'), 100)` | `{{2}}` body — reviewer name |
| 3 | `String(params.starRating)` | `{{3}}` body — star rating |
| 4 | `truncate(oneLine(params.reviewDate), 12)` | `{{4}}` body — review date |
| 5 | `truncate(oneLine(params.reviewText ?? '(no comment)'), REVIEW_TEXT_MAX)` | `{{5}}` body — review text |
| 6 | `truncate(oneLine(params.responsePreview), RESPONSE_PREVIEW_MAX)` | `{{6}}` body — draft reply preview |
| 7 | `` `a:${params.approvalLinkId}` `` | `{{7}}` → Approve button `id` |
| 8 | `` `r:${params.approvalLinkId}` `` | `{{8}}` → Regenerate button `id` |
| 9 | `extractTokenFromApprovalUrl(params.approvalUrl)` | `{{9}}` → URL button suffix (raw approval token) |

**Verdict: PASS.** All nine positional indices map exactly to the documented `whatsapp/card` body (`{{1}}`–`{{6}}`) and the three buttons (`{{7}}`/`{{8}}` QUICK_REPLY ids, `{{9}}` URL suffix). The renderer was **not** modified — the body template constant (`APPROVAL_CARD_BODY_TEMPLATE`) and the index order are unchanged, so this validation does **not** restart the Meta review clock.

#### Go-live record (record at flip, do not invent)

- **Approved Content SID:** `HX________ (record at go-live)` — paste the `HX…` SID Twilio returns after Meta approves, then set it as `WHATSAPP_APPROVAL_TEMPLATE_SID` on both platforms below.
- **Variable-map gate:** PASS (2026-06-26, above). Re-run this diff before any resubmission.

**7-env-var go-live checklist — set on BOTH Vercel (UI + routes) AND Railway (worker)** (authoritative matrix below; `assertChannelsWhatsAppEnv` enforces presence + format + URL-base equality on the Railway side):

- [ ] `CHANNELS_WHATSAPP_ENABLED` — keep `false` until the 8-point ship gate passes (Vercel + Railway)
- [ ] `TWILIO_ACCOUNT_SID` (Vercel + Railway)
- [ ] `TWILIO_AUTH_TOKEN` (Vercel + Railway)
- [ ] `TWILIO_WHATSAPP_NUMBER` — format `whatsapp:+<digits>` (Vercel + Railway)
- [ ] `WHATSAPP_APPROVAL_TEMPLATE_SID` — the `HX…` SID above (Vercel + Railway)
- [ ] `WHATSAPP_APPROVAL_URL_BASE` — MUST equal `NEXT_PUBLIC_APP_URL + '/approve/'` exactly (Vercel + Railway)
- [ ] `NEXT_PUBLIC_APP_URL` (Vercel + Railway)
- [ ] `WORKER_PUBLIC_URL` — **Railway worker only** (Twilio webhook registration)

### Submission JSON (Twilio Content API)

Submit via the Content Editor UI or the `/v1/Content` POST endpoint. Field names verified against https://www.twilio.com/docs/content/whatsappcard (2026-05-22).

```json
{
  "friendly_name": "repworth_approval_request_v1",
  "language": "en",
  "variables": {
    "1": "Acme Co",
    "2": "Jane D",
    "3": "3",
    "4": "Apr 18",
    "5": "Good service",
    "6": "Thanks Jane!",
    "7": "a:abc123",
    "8": "r:abc123",
    "9": "tok_abc123"
  },
  "types": {
    "whatsapp/card": {
      "body": "New ⭐{{3}} review for {{1}}\n\nFrom: {{2}} · {{4}}\n\n\"{{5}}\"\n\nDraft reply:\n{{6}}",
      "actions": [
        { "type": "QUICK_REPLY", "title": "Approve", "id": "{{7}}" },
        { "type": "QUICK_REPLY", "title": "Regenerate", "id": "{{8}}" },
        { "type": "URL", "title": "Edit / view full", "url": "https://app.repworth.com/approve/{{9}}" }
      ]
    }
  }
}
```

After Meta approves, Twilio returns a Content SID prefixed `HX...`. That SID goes into the `WHATSAPP_APPROVAL_TEMPLATE_SID` env var. Record the SID in this section once issued.

### Vercel + Railway environment matrix

Next.js routes and the `/settings/channels` UI run on **Vercel**; the notification worker runs on **Railway**. The flag and all WhatsApp env vars must be set on **both platforms** — missing vars on either side leave the UI hidden/404/503 even when the other side is ready.

| Variable | Vercel (UI + routes) | Railway (worker) | Notes |
|----------|---------------------|-----------------|-------|
| `CHANNELS_WHATSAPP_ENABLED` | ✅ | ✅ | Keep `false` until ship gate passes |
| `TWILIO_ACCOUNT_SID` | ✅ | ✅ | |
| `TWILIO_AUTH_TOKEN` | ✅ | ✅ | |
| `TWILIO_WHATSAPP_NUMBER` | ✅ | ✅ | Format: `whatsapp:+<digits>` |
| `WHATSAPP_APPROVAL_TEMPLATE_SID` | ✅ | ✅ | `HX...` SID returned by Twilio after Meta approves |
| `WHATSAPP_APPROVAL_URL_BASE` | ✅ | ✅ | Must equal `NEXT_PUBLIC_APP_URL + '/approve/'` exactly |
| `NEXT_PUBLIC_APP_URL` | ✅ | ✅ | |
| `WORKER_PUBLIC_URL` | — | ✅ | Worker-only; used for Twilio webhook registration |

`assertChannelsWhatsAppEnv` (worker boot) enforces 7 vars + `whatsapp:+…` format + URL-base equality on the Railway side. If `WHATSAPP_APPROVAL_URL_BASE` does not equal `NEXT_PUBLIC_APP_URL + '/approve/'` the worker refuses to start.

The flag stays `false` on both platforms until the canary + ship gate completes (see below).

### Canary enablement + ship gate

The Phase 3 §5.1 ship gate exercises the flag-gated enrollment routes, so the flag must be `true` in a controlled scope **before** the full flip. Choose one canary approach:

**(a) Staging canary (preferred):** Enable the flag in a dedicated staging environment that has its **own** Meta-approved template SID and URL base. The URL-base equality check (`assertChannelsWhatsAppEnv`) forbids sharing the production template SID with a staging URL base — staging must submit its own template variant to Meta. Run the full eight-point gate in staging.

**(b) Prod time-boxed canary:** Flip `CHANNELS_WHATSAPP_ENABLED=true` in production but enroll **only the pilot business**. Send attempts are naturally scoped to businesses with a verified WhatsApp enrollment, so only the pilot receives WhatsApp notifications. Run the gate, then keep the flag on for GA or flip back off if the gate fails.

#### Eight-point ship gate (Phase 3 §5.1)

Run all eight checks in the chosen canary scope before the full flag flip:

- [ ] Webhook signature verification — Twilio signature on inbound messages is validated; replayed/unsigned requests are rejected.
- [ ] Click-to-chat enrollment — owner scans QR / opens deep link → sends `start-<token>` → enrollment status transitions to `verified`.
- [ ] Approve round-trip — send a test notification → tap Approve → response posts (or queues for posting) correctly.
- [ ] Regenerate round-trip — tap Regenerate → new draft generated and re-sent via WhatsApp.
- [ ] Blocked-recipient handling — recipient blocks the business (Twilio 63014/63033) → enrollment set to `unsubscribed` (reason `whatsapp_blocked`); no further messages sent to that handle.
- [ ] Re-enrollment — after STOP, owner re-initiates enrollment → new token issued → enrollment returns to `verified`.
- [ ] Cross-channel race — pilot business has an active Telegram enrollment; WhatsApp start attempt returns 409 `multiple_mobile_channels` with the correct reducer copy.
- [ ] STOP inside session — recipient replies STOP → enrollment set to `unsubscribed` (reason `whatsapp_stop`); Twilio's native opt-out is also honored; no further messages sent.

#### Full flag flip

Once all eight gate items pass:

1. Set `CHANNELS_WHATSAPP_ENABLED=true` on **both Vercel and Railway**.
2. Redeploy both services.
3. Confirm the Railway worker boots cleanly — `assertChannelsWhatsAppEnv` logs no errors.
4. Verify the owner widget is visible in `/settings/channels` for at least one pilot account.

### Copy-lock note

Template copy is **locked** only after the variable map validation gate (above) passes and the `whatsapp/card` submission JSON is confirmed correct. Any wording change to `body`, button labels, or button URL after Meta submission restarts the review clock — typically 1–5 business days. The `_v1` suffix in `repworth_approval_request_v1` reserves room for versioned resubmits (`_v2`, etc.) if a copy change is unavoidable.

### What triggers a resubmission

Any of these changes requires Meta re-review (clock restarts at submit time):

- Body text edit (wording, whitespace, emoji).
- Button label change (e.g. "Approve" → "Yes, post this").
- Button count change (adding/removing buttons).
- Button URL base change (`app.repworth.com` → anything else).
- Category change (UTILITY → MARKETING etc.).
- Variable count or index order change (requires matching code change first).

These do NOT trigger re-review (safe to change freely per send):

- Variable values 1–9.
- Twilio API-level retry/delivery options.
- `statusCallback` URL.

### Testing during development

Before Meta approves the real template, use Twilio's WhatsApp sandbox:

1. Join the sandbox per Twilio console instructions (`join <keyword>` SMS).
2. `TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886` (Twilio's sandbox sender).
3. `WHATSAPP_APPROVAL_TEMPLATE_SID=<sandbox template SID>` — sandbox accepts free-form sends, so a minimal template SID is sufficient for end-to-end wiring.
4. Keep `CHANNELS_WHATSAPP_ENABLED=false` in production until the real template is approved and the ship gate passes.

---

## `repworth_autopost_notice_v1`

**Purpose:** Tell a business owner that their auto-approval policy approved AND
posted a reply to a new review (the per-event FYI, Workstream B). One-way — the
FYI has **no** approve/regenerate buttons (the post already happened) and **no**
approval link. Only a single "View on Google" URL button.

**Twilio Content type:** `whatsapp/card` (same as the approval template — gives a
real `body` field plus a URL button).

**Meta category:** UTILITY (transactional — it confirms an action the owner's
policy already authorized). If Meta reclassifies as MARKETING, the copy may need
a rework; the `_v1` suffix reserves room for a versioned resubmit.

**Body text:**

```
✅ Auto-approved reply posted for {{1}}

Your reply to {{2}}'s ⭐{{3}} review was approved by your auto-policy and posted to Google. No action needed.
```

**Variables:** (must match `formatAutoPostNoticeWhatsApp` in `src/lib/notifications/channels/whatsapp-body.ts` — keys `"1"`–`"4"`, passed positionally)

| Index | Content | Type | Max length | Null-safe default |
|-------|---------|------|------------|-------------------|
| 1 | Business name | string | 100 | — (always set) |
| 2 | Reviewer name | string | 100 | `"Reviewer"` if missing |
| 3 | Star rating | string `"1"`–`"5"` | 1 | — |
| 4 | URL button suffix (responseId, a UUIDv7) | string | 36 | — |

**Buttons:**

| Index | Type | Label | Dynamic content |
|-------|------|-------|-----------------|
| 0 | URL | View on Google | `url` field = `https://app.repworth.com/r/google/{{4}}` |

**URL button base:** `https://app.repworth.com/r/google/` — a **fixed prefix +
dynamic `{{4}}` suffix** (the same shape Meta already approved for the approval
template's `/approve/{{9}}` button — verified viable in production). The route
`/r/google/<responseId>` 302-redirects to the business's Google Maps URL after a
host allowlist + `status='posted'` check, and renders an "unavailable" page when
the destination is unknown. There is **no env-var equality assertion** for this
base (unlike `WHATSAPP_APPROVAL_URL_BASE`) — the suffix is the responseId, not a
secret token, and the redirect is server-validated.

### Submission JSON (Twilio Content API)

Submit via the Content Editor UI or `POST /v1/Content`. After Meta approves,
Twilio returns an `HX...` Content SID — set it as `WHATSAPP_AUTOPOST_TEMPLATE_SID`
on **both** Vercel and Railway. If unset, the WhatsApp FYI is skipped gracefully
(email + Telegram still send); it is **NOT** a startup-required var.

```json
{
  "friendly_name": "repworth_autopost_notice_v1",
  "language": "en",
  "variables": { "1": "Acme Co", "2": "Jane D", "3": "5", "4": "019db8c1-c3f4-7668-b353-2b8b718ec603" },
  "types": {
    "whatsapp/card": {
      "body": "✅ Auto-approved reply posted for {{1}}\n\nYour reply to {{2}}'s ⭐{{3}} review was approved by your auto-policy and posted to Google. No action needed.",
      "actions": [
        { "type": "URL", "title": "View on Google", "url": "https://app.repworth.com/r/google/{{4}}" }
      ]
    }
  }
}
```

**Variable-map validation gate (before submitting):** diff `{{1}}`–`{{4}}`
against `formatAutoPostNoticeWhatsApp` — `"1"`=businessName, `"2"`=reviewerName
(`|| 'Reviewer'`), `"3"`=`String(starRating)`, `"4"`=responseId (URL suffix).

**What triggers a resubmission:** body wording, the button label/URL base, the
category, or the variable count/order — same rules as the approval template.

### Environment SIDs

The formatter (`formatAutoPostNoticeWhatsApp`) is URL-agnostic — it only passes
the responseId as `{{4}}`; the URL base lives in the Meta-approved template. So
each environment needs its **own** approved template whose button base matches
that env's `NEXT_PUBLIC_APP_URL`, selected via `WHATSAPP_AUTOPOST_TEMPLATE_SID`.

| Env | Template name | URL button base | SID | Meta status |
|-----|---------------|-----------------|-----|-------------|
| Prod | `repworth_template_auto_notification_v1` | `https://app.repworth.com/r/google/{{4}}` | `HX2b3687d27c34e5d7cfca5c015c0f8069` | approved |
| Staging | `repworth_autopost_notice_staging_v1` | `https://staging.repworth.net/r/google/{{4}}` | `HXef1d6b4db0697ef817eba0deac1c45df` | approved 2026-06-17; env repointed (effective next worker deploy) |

> **Staging repoint — DONE 2026-06-17.** Meta approved the staging SID and
> `WHATSAPP_AUTOPOST_TEMPLATE_SID=HXef1d6b4db0697ef817eba0deac1c45df` is set on
> **staging** Railway worker + Vercel. It was set with Railway `--skip-deploys`,
> so the **running** worker still holds the old value until the next staging
> deploy picks up the new env — the next `git push` to `staging` (or any worker
> redeploy that reads current env) makes it live. Do NOT rely on
> `railway variables --set` alone to restart, and avoid `railway redeploy` (it
> reuses the stale env snapshot). Staging-only — prod keeps its own SID. Only
> matters when testing the auto-approval lane (`AUTO_APPROVAL_ENABLED=true`); the
> owner-approval card is unaffected.

---

## Escalation notice (`WHATSAPP_ESCALATION_TEMPLATE_SID`)

**Purpose:** Tell a business owner that Guardian triage flagged a review needing
their attention (WS3). One-way — no approve/regenerate buttons and no approval
link (this is not the reply-approval flow). No URL button either: the owner
acknowledges/resolves from the dashboard, not a deep link, so the notice is
text-only until a future URL-button suffix is added (variable 5 is reserved for
that).

**Twilio Content type:** `whatsapp/card` (same as the other two templates).

**Meta category:** UTILITY (transactional — it reports a triage outcome, not a
promotion). If Meta reclassifies as MARKETING, the copy may need a rework; the
`_v1` suffix reserves room for a versioned resubmit.

**Proposed body text:**

```
🚨 {{1}}: a review from {{2}} ({{3}}★) was assessed as {{4}} and needs your attention.

Open your RepWorth dashboard to acknowledge.
```

**Variables:** (must match `formatEscalationNoticeWhatsApp` in
`src/lib/notifications/channels/whatsapp-body.ts` — keys `"1"`–`"5"`, passed
positionally)

| Index | Content | Type | Max length | Null-safe default |
|-------|---------|------|------------|-------------------|
| 1 | Business name | string | 100 | — (always set) |
| 2 | Reviewer name | string | 100 | `"Reviewer"` if missing |
| 3 | Star rating | string `"1"`–`"5"` | 1 | `"–"` if rating-less |
| 4 | Severity label | string, e.g. `"High severity"` \| `"Needs a look"` (fallback) | ~20 | — (always set) |
| 5 | Escalation id (`review_escalations.id`) | string (UUIDv7) | 36 | — (reserved for a future URL-button suffix; not rendered in the body copy above) |

**Buttons:** none in the proposed v1 body. If a future revision adds a
dashboard-deep-link URL button, it would use `{{5}}` as the suffix (mirroring
the `/r/google/{{4}}` pattern in `repworth_autopost_notice_v1`) — that change
requires a fresh Meta review cycle.

### Submission JSON (Twilio Content API)

Submit via the Content Editor UI or `POST /v1/Content`. After Meta approves,
Twilio returns an `HX...` Content SID — set it as
`WHATSAPP_ESCALATION_TEMPLATE_SID` on **both** Vercel and Railway. If unset,
the WhatsApp escalation notice is skipped gracefully (email + Telegram still
send); it is **NOT** a startup-required var.

```json
{
  "friendly_name": "repworth_escalation_notice_v1",
  "language": "en",
  "variables": {
    "1": "Acme Diner",
    "2": "Jane D",
    "3": "1",
    "4": "High severity",
    "5": "019db8c1-c3f4-7668-b353-2b8b718ec603"
  },
  "types": {
    "whatsapp/card": {
      "body": "🚨 {{1}}: a review from {{2}} ({{3}}★) was assessed as {{4}} and needs your attention.\n\nOpen your RepWorth dashboard to acknowledge."
    }
  }
}
```

**Variable-map validation gate (before submitting):** diff `{{1}}`–`{{5}}`
against `formatEscalationNoticeWhatsApp` — `"1"`=businessName, `"2"`=reviewerName
(`|| 'Reviewer'`), `"3"`=`String(starRating)` or `'–'` when rating-less,
`"4"`=severityLabel (computed in `WhatsAppChannel.sendEscalationNotice`:
`'Needs a look'` for fallback-sourced escalations, else `'<Severity> severity'`),
`"5"`=escalationId (unused by the v1 body; reserved).

**What triggers a resubmission:** body wording, adding/removing a button, the
category, or the variable count/order — same rules as the other two templates.

### Environment SIDs

Each environment needs its own approved template, selected via
`WHATSAPP_ESCALATION_TEMPLATE_SID`. Record SIDs here once issued:

| Env | Template name | SID | Meta status |
|-----|---------------|-----|-------------|
| Prod | `repworth_escalation_notice_v1` | `HX________ (record at go-live)` | not yet submitted |
| Staging | `repworth_escalation_notice_staging_v1` | `HX________ (record at go-live)` | not yet submitted |
