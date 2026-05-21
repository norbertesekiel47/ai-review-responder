# WhatsApp Content Templates

This file is the authoritative reference for every WhatsApp template RepWorth submits to Meta via the Twilio Content API. The running code (`src/lib/notifications/channels/whatsapp-body.ts`) renders variables against the template shapes defined here; any shape change here requires a code change there and a fresh Meta review cycle.

## `repworth_approval_request_v1`

**Purpose:** Notify a business owner that a new review has arrived and a draft response is ready for approval. Sent outbound from RepWorth; receives button replies back via `/ingress/twilio/whatsapp-inbound`.

**Twilio Content type:** `twilio/card`

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
| 0 | QUICK_REPLY | Approve | payload = `{{7}}` |
| 1 | QUICK_REPLY | Regenerate | payload = `{{8}}` |
| 2 | URL | Edit / view full | url = `https://app.repworth.com/approve/{{9}}` |

**URL button base:** `https://app.repworth.com/approve/` — Meta-approved at submission. Runtime assertion in `worker/startup-assert.ts::assertChannelsWhatsAppEnv` fails boot if `WHATSAPP_APPROVAL_URL_BASE` env var does not equal `NEXT_PUBLIC_APP_URL + '/approve/'`. Staging / local environments MUST use a different approved template SID (with their own URL base) or run flag-off.

### Submission JSON (Twilio Content API)

When submitting via the Content Editor UI or the `/v1/Content` POST endpoint:

```json
{
  "friendly_name": "repworth_approval_request_v1",
  "language": "en",
  "variables": { "1": "Acme Co", "2": "Jane D", "3": "3", "4": "Apr 18", "5": "Good service", "6": "Thanks Jane!", "7": "a:abc", "8": "r:abc", "9": "tok123" },
  "types": {
    "twilio/card": {
      "title": "",
      "subtitle": "",
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

After Meta approves, Twilio returns a Content SID prefixed `HX...`. That SID goes into the `WHATSAPP_APPROVAL_TEMPLATE_SID` env var. Record the SID in the launch runbook.

### What triggers a resubmission

Any of these changes requires Meta re-review (clock restarts at submit time):

- Body text edit (wording, whitespace, emoji).
- Button label change (e.g. "Approve" → "Yes, post this").
- Button count change (adding/removing buttons).
- Button URL base change (`app.repworth.com` → anything else).
- Category change (UTILITY → MARKETING etc.).

These do NOT trigger re-review (safe to change freely per send):

- Variable values 1–9.
- Twilio API-level retry/delivery options.
- `statusCallback` URL.

### Testing during development

Before Meta approves the real template, use Twilio's WhatsApp sandbox:

1. Join the sandbox per Twilio console instructions (`join <keyword>` SMS).
2. `TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886` (Twilio's sandbox sender).
3. `WHATSAPP_APPROVAL_TEMPLATE_SID=<sandbox template SID>` — sandbox accepts free-form sends, so a minimal template SID is sufficient for end-to-end wiring.
4. Keep `CHANNELS_WHATSAPP_ENABLED=false` in production until the real template is approved.
