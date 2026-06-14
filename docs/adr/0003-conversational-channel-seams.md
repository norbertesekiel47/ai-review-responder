# ADR 0003: Conversational-channel seams for a future RepWorth AI Agent

## Status

Accepted — 2026-06-14

## Context

RepWorth's Telegram and WhatsApp channels are inbound webhooks today: a verified
owner taps an Approve/Regenerate button or sends a `/start <token>` enrollment
message, and the ingress handlers (`worker/ingress/telegram/*`,
`worker/ingress/twilio/*`) dispatch exactly those flows. Any other inbound text —
a free-form "make my reply shorter", "what's pending?", etc. — is currently
dropped (Telegram) or logged-and-acknowledged (WhatsApp).

A future RepWorth AI Agent (two-way conversational control over a business's
reviews) will want to handle that free-text. We are **not** building it now. But
the channels-rollout work flips these channels on for production, so we want the
ingress shaped so the agent does not require re-architecting ingress — and,
critically, so the act of flipping the channels on does not quietly create an
unauthenticated bot surface or start persisting raw user text.

## Decision

Ship a **minimal, reversible seam** with two boundaries baked in, and nothing
more.

1. **One named extension point.** Non-command, non-button free text routes to a
   single handler, `handleConversationalMessage`
   (`worker/ingress/conversational-seam.ts`), from both the Telegram and WhatsApp
   ingress. Today it is a deliberate **no-op**: it acknowledges, marks the
   `inbound_events` row processed, and sends **no reply**. The future agent plugs
   its response logic in here.

2. **Redaction boundary (Codex R1 #9).** No raw user text reaches the audit
   trail. The Telegram redactor (`redactForAudit`) now strips **all** message
   bodies (previously only `/start ` tokens); the WhatsApp redactor
   (`redactWhatsAppPayload`) already strips `Body`. Both run before the
   `inbound_events` insert. The live dispatch reads the *original* update (so
   enrollment still extracts its token) — only the persisted audit clone is
   redacted.

3. **Auth boundary (Codex R1 #10).** A future conversational *response* is
   allowed **only** for a verified, non-archived enrollment tied to an account
   that can still be served (`active`, or `past_due` within grace).
   `isAuthorizedConversationalSender(channel, senderHandle)` encodes that gate and
   is exported as the single predicate the agent must pass before replying.
   Unknown / unenrolled senders are silently acknowledged — never an
   unauthenticated bot surface. The seam resolves and logs this gate today so it
   cannot be widened by accident.

### Deferred deliberately

- **No NLU, no agent, no two-way chat.** Out of scope.
- **No conversation store.** We do not add a messages table or persist
  conversation history now. The redaction boundary means we *cannot* — by design
  — until an explicit conversation-storage/privacy design exists.
- **No generic `sendText` channel method.** The channels expose
  `sendApprovalRequest` and `sendAutoPostNotice` (both purpose-built). A generic
  free-form `sendText` is the obvious extraction for an agent, but we wait for
  the agent to be the **second** real use case before extracting it (avoids a
  speculative abstraction with one caller).

### The one hard platform constraint the agent must design around

**WhatsApp's 24-hour session window.** Free-form WhatsApp messages are legal only
within 24h of the user's last inbound message; outside that window only approved
templates may be sent (Twilio error 63016 = `WhatsAppSessionWindowError`). A
conversational agent on WhatsApp must therefore either reply within the 24h
window opened by the user's inbound message, or fall back to an approved template.
Telegram and email have no equivalent constraint.

## Consequences

- Flipping the channels on does not create an unauthenticated surface or persist
  raw text — the two boundaries ship with the seam, not "later".
- The agent's future work is additive: implement a response inside
  `handleConversationalMessage`, gated on `isAuthorizedConversationalSender`,
  honoring the WhatsApp 24h window; then (and only then) extract a generic
  `sendText` and design the conversation store.
- A small cost: every free-text inbound now runs one enrollment-lookup query to
  resolve the auth gate. Volume is low (bots receive little unsolicited text) and
  the ingress already writes an `inbound_events` row per message.
