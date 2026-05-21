# Round 2 — Approval Flow & Token Security

**Audit date:** 2026-04-26
**Scope:** Approval token lifecycle (generation, hashing, lookup, consume, revoke, expire), device-cookie + CSRF binding, channel-scoped approval-link delivery (email/SMS/Telegram/WhatsApp), and webhook-callback approval paths (`approveViaCallback` / `regenerateViaCallback`).
**Methodology:** Whitebox source review across `src/lib/approval/*`, `src/app/api/approve/*`, `src/lib/notifications/channels/*`, and `worker/ingress/{telegram,twilio-whatsapp}-*.ts`. Two parallel sub-agents followed by direct verification of every Critical/High claim against the actual source. Several agent findings turned out to be false positives — those are documented under "Verified Safe" with the reasoning that ruled them out.

**Severity rubric:** Critical = unauthenticated approval bypass / token forgery / cross-business compromise. High = single-business takeover with prereqs. Medium = race-window or known-trust-model exploits. Low = hardening. Informational = design notes.

---

## Findings (by severity)

### [HIGH] H-1: Email approval link confers full edit + approve + regenerate authority — `EditedText` is not sanitized for HTML/control chars before storage

- **Location:** `src/app/api/approve/[token]/edit/route.ts:12, 66`; `src/lib/approval/token-mode.ts:74-112` (the `edit()` mutation that writes `${editedText}` into `responses.approved_text`)
- **Description:** The edit endpoint validates that `editedText.length <= MAX_EDIT_LENGTH (2000)` and trims whitespace, but performs no other sanitization. The text is written directly into `responses.approved_text` and later flows into the `awaiting_manual_post` state where the sales partner copies it to Google. Today this is a copy-paste workflow so HTML doesn't render anywhere — but the same column will feed the GBP API auto-post path in Phase 5 (per `CLAUDE.md` migration plan), at which point any markup, escape sequences, or zero-width unicode an attacker injects will land verbatim on Google reviews.
- **Impact:** Anyone who possesses the email approval URL (lost phone with lock-screen preview, intercepted email, an attacker who beats the owner to the device-bind race, or a future XSS that can read approval URLs from the dashboard) can publish arbitrary text up to 2000 chars under the business's own Google account. Today the sales partner is a manual gate; once GBP auto-post ships, it's the only gate.
- **Proof of concept:** Attacker captures the URL `https://app.repworth.net/approve/<token>` from a lock-screen SMS preview. Loads it in their own browser. Their browser becomes the first to POST `/session`, binding their device cookie. They POST `/edit` with a 2000-char defamatory or off-brand reply. Response transitions to `edited` → `awaiting_manual_post`. In SerpAPI mode, the sales partner posts it (without reading carefully). In future GBP-API mode, the worker auto-posts it.
- **Recommended fix:** Add a sanitization pass on `editedText` before storage: strip HTML tags / entities, reject zero-width and bidi-override unicode (`​-‏`, `‪-‮`, `⁦-⁩`), normalize whitespace. The same pass should be applied at the GBP-API publish boundary too (defense in depth). For the immediate trust-model concern, also consider lowering the email-link expiry from 48h to e.g. 24h and adding an "approve required confirmation step" on edits over a length threshold.

---

### [MEDIUM] M-1: SMS approval URL is delivered in cleartext SMS body — visible on lock-screen previews

- **Location:** `src/lib/notifications/channels/sms-channel.ts` (and the SMS body builder at `src/lib/notifications/sms-body.ts` per Phase 1 inventory)
- **Description:** The full approval URL with the raw token is embedded in the SMS body. iOS and Android default lock-screen settings show SMS previews. Anyone who briefly sees the screen — coworker, person at the airport, family member — sees a working approval URL valid for 48 hours.
- **Impact:** Cross-channel link compromise with no malware required. Combined with H-1 above, the lock-screen viewer can publish arbitrary text under the business name. Today, the consequence is the partner posts whatever the attacker submitted; tomorrow, GBP API auto-posts it.
- **Proof of concept:** (1) Owner enrolls SMS channel. (2) Owner gets a notification while phone is on a desk. (3) Coworker glances at the lock-screen preview, copies the URL into their own browser, edits the response with a slur, submits.
- **Recommended fix:** Either (a) deliver only a short opaque code in SMS that requires the owner to log into a "Tap to approve" mini-page (short-lived, single-use), (b) tighten SMS-link expiry to 1–2h instead of 48h, or (c) add a one-tap step-up on the approval page that requires a second value the owner has via another channel (login, OTP). H-1's mitigations partially cover this once edits are length/sanitization gated.

---

### [MEDIUM] M-2: First-device-wins binding race can permanently lock out the legitimate owner

- **Location:** `src/lib/approval/session-mode.ts` (the `establishApprovalSession` transaction that writes `approval_links.device_cookie_hash` on first POST `/session`)
- **Description:** When two browsers GET the approval link and both POST `/session` near-simultaneously, the second `UPDATE approval_links SET device_cookie_hash = ...` overwrites the first. The browser whose hash was overwritten can no longer approve (verifyDevice() throws DeviceConflictError). The two-browser scenario is more common than it sounds: corporate email security gateways pre-fetch URLs (those do GET only and don't run JS, so they don't bind — that's safe), but Outlook desktop with link previewing, or a previewing extension in the same browser, can run a real `/session` POST. So can a single user opening the link on two devices.
- **Impact:** UX-grade DoS and (worse) attack-window: an attacker who races the owner to `/session` permanently captures the approval. Because the device cookie is HttpOnly and cookie-bound to the attacker's session, the legitimate owner's subsequent attempts fail with no recovery path other than waiting for a regenerate.
- **Proof of concept:** Attacker monitors owner's inbox (compromised email account). The moment a notification email arrives, attacker fetches `/api/approve/<token>` then immediately POSTs `/session` from a script. Owner clicks the link a few seconds later — bind fails because `device_cookie_hash` already pinned to attacker's value. Owner sees "device mismatch" with no obvious next step.
- **Recommended fix:** Either (a) make the bind atomic and refuse the second one — `UPDATE … WHERE device_cookie_hash IS NULL RETURNING id`, surface a clear "this link was opened from another device" error to the loser, OR (b) accept multiple device hashes per link (denormalize into a child table) so any of N bound devices can act. (a) is closer to the current threat model.

---

### [MEDIUM] M-3: `SESSION_COOKIE_SECRET` length is not validated at runtime

- **Location:** `src/lib/approval/cookies.ts:33-37` (`getSessionSecret()`)
- **Description:** The accessor checks that the env var exists and throws if it's missing, but does not enforce a minimum length. A weak operator-set secret like `"changeme"` would silently work. The HMAC-SHA256 device-cookie signature derives all its security from this secret's entropy — if it's short, the device cookie is forgeable via brute force.
- **Impact:** If the secret is ever set to a weak value (operator mistake, copy-paste of an example), an attacker can forge device cookies, which means they can win the binding race deterministically and approve/edit any link they obtain. The mitigation today is "operator must use a strong secret", which is implicit not enforced.
- **Recommended fix:** In `getSessionSecret()`, reject any secret shorter than 32 bytes: `if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('SESSION_COOKIE_SECRET must be ≥32 bytes')`. Same treatment for `CSRF_SECRET` if not already enforced (audit Round 5).

---

### [LOW] L-1: Email-scanner GET requests do not write `device_cookie_hash` (good) but DO populate audit log with scanner IP/UA on subsequent `/session` calls if the scanner runs JS

- **Location:** `src/app/api/approve/[token]/route.ts` (GET — sets cookies only); `src/lib/approval/session-mode.ts` (the `/session` POST that writes audit + device hash)
- **Description:** The GET handler is read-only and does not consume the token or bind a device — that's correct. However, the device cookie is set on the GET response, so a scanner that runs JS would call `/session` next and produce an audit-log entry attributed to the scanner's IP/UA before the owner ever opens the link. Most enterprise scanners (Proofpoint, Mimecast, Microsoft Defender Safe Links, Google's image-fetcher) don't execute JS, so in practice this is rare — but Outlook desktop, some browser plugins, and any preview pane that renders the page CAN run JS. If they do, they win the device-bind race (M-2) AND poison the audit trail.
- **Impact:** Audit-log noise; potential M-2 amplifier. Not exploitable on its own.
- **Recommended fix:** In the `/session` POST, add a User-Agent allow-list that requires "looks like a real browser" (presence of `Mozilla/5.0` + `WebKit|Gecko|Trident`) and reject bot-like UAs. Pair with a small JS challenge so headless requests fail. Cheap defense-in-depth.

---

### [INFORMATIONAL] I-1: Cross-channel sibling revocation on approval is intended behavior — not a bug

- **Location:** `src/lib/approval/locks.ts:83-91` (`revokeSiblings`)
- **Description:** When a response is approved/edited/regenerated via any channel, ALL sibling approval links across all channels are revoked. Sub-agent flagged this as "compromised email link revokes Telegram link" — that's correct mechanically but is the desired behavior: once a response transitions out of `pending_approval`, no other channel's link should be usable to act on it again. Documenting here so future readers know it's a feature, not a regression.
- **Action:** None. Add a one-line comment in `revokeSiblings()` reinforcing the intent so a future contributor doesn't "fix" it.

---

### [INFORMATIONAL] I-2: Callback-mode (Telegram/WhatsApp) does not check device-cookie hash — by design; the chat_id binding is the equivalent

- **Location:** `worker/ingress/telegram-callback.ts:88-105`; `src/lib/approval/callback-mode.ts`
- **Description:** Token-mode browser approvals require `verifyDevice(link, deviceCookieHash)`. Callback-mode (Telegram inline button, WhatsApp button payload) skips this check. The functional substitute is the strict enrollment lookup `WHERE business_id = ${link.business_id} AND handle = ${senderId} AND status='verified' AND archived_at IS NULL` — the chat_id IS the persistent device identity for native bot channels.
- **Action:** None. The trust model is consistent — there's no browser cookie in a Telegram chat. Worth noting in architecture docs. Importantly, this means a Telegram-account takeover of an enrolled chat can approve without anything the device-cookie scheme would catch — but that's the inherent property of any "approve via Telegram button" UX.

---

### [INFORMATIONAL] I-3: 48h approval-link lifetime is uniform across channels

- **Location:** `src/lib/approval/create-link.ts:76-82`
- **Description:** All channels share the same 48h expiry. Email and dashboard (browser) make sense at that horizon — owner might be travelling. SMS is exposed via lock-screen preview for the full 48h. Telegram/WhatsApp messages persist in chat history indefinitely (until user deletes them).
- **Action:** Consider per-channel expiry — SMS 2-4h, email/web 48h, Telegram/WhatsApp 24h. Pair with M-1 / H-1 to bound exposure of compromised links.

---

## Verified safe (claims investigated, no finding)

| # | Claim | Status | Reason |
|---|---|---|---|
| 1 | Token entropy | **Safe** | `randomUUID()` (122 bits) used in `create-link.ts:29`, `cookies.ts:47, 106`. No `Math.random` fallback anywhere; no custom alphabets. |
| 2 | Token hashing algorithm | **Safe** | SHA-256 via `node:crypto.createHash('sha256')` at `create-link.ts:30` and all consumers. No MD5/SHA-1. |
| 3 | Constant-time HMAC verify | **Safe** | `cookies.ts` uses `crypto.timingSafeEqual` for both `__device` HMAC verify and `__csrf` cookie compare. |
| 4 | Raw token in logs / Sentry / outbox | **Safe** | Grepped `src/lib/approval/*` — no `console.log`/`logger`/Sentry call carries `rawToken`. Outbox payload (`PublishResponsePayload`) carries `response_id`+`business_id`+`correlation_id` only — no token. Audit log stores `token_hash` not raw. |
| 5 | GET endpoint mutates state | **Safe** | `route.ts` is read-only; the `consumed_at`/`device_cookie_hash` writes happen on `POST /session` and `POST /{approve\|edit\|regenerate}`. Email scanners that GET-only don't bind (good). |
| 6 | Token expiry checked on all endpoints | **Safe** | `lockValidLink` (`locks.ts:48`) and `lockLinkByIdForCallback` (`locks.ts:125`) both check `expires_at > NOW()`. GET landing page also checks. Every entry validates expiry before action. |
| 7 | Cross-business approval via parameter swap | **Safe** | The `link.business_id` and `link.response_id` are READ from the same `approval_links` row in `lockValidLink` — they are never client-supplied. There is no parameter the attacker could manipulate to make a token for response X act on business Y. (Sub-agent claimed Critical here; the attack as described requires the link row itself to have a `business_id`/`response_id` mismatch, which can only come from a write-side bug — none present.) |
| 8 | Concurrent approve race / double-publish | **Safe** | `lockPendingResponse` uses `SELECT … FOR UPDATE`; consumeLink + status update are in the same tx; non-terminal-response uniqueness via migration 023 partial index. Two simultaneous approves → one wins, one rolls back with `ResponseNotPendingError`. |
| 9 | Approve-then-regenerate sequence | **Safe** | Regenerate path (`token-mode.ts:119-148`) calls `lockPendingResponse`, which throws if status ≠ `pending_approval`. After approve, status is `approved`, so the second action rolls back cleanly. |
| 10 | Revoked-link reuse after regenerate | **Safe** | `revokeSiblings` runs in the same tx as `consumeLink` + `UPDATE responses SET status='superseded'`. Atomic — old links are revoked before a new draft can be requested. |
| 11 | Telegram callback authentication | **Safe** | `worker/ingress/telegram-callback.ts:88-97` enforces `WHERE business_id = ${link.business_id} AND handle = ${senderId} AND status='verified' AND archived_at IS NULL`. (a) Webhook secret prevents external forgery. (b) chat_id binding prevents wrong-business approval. (c) `archived_at IS NULL` prevents historical-handle reuse across business transfers. |
| 12 | Telegram `callback_data` plaintext = forge-able | **Safe** | The agent argued for HMAC-signing the `callback_data` field. Adds nothing under the current trust model: external attackers can't reach the webhook (signed with `TELEGRAM_WEBHOOK_SECRET`), and an attacker inside an enrolled chat is already the legitimate owner. Signing `callback_data` with the same secret that protects the webhook is redundant. |
| 13 | Cross-channel link masquerade | **Safe** | `lockLinkByIdForCallback` (`locks.ts:122`) enforces `link.channel === expectedChannel` — an SMS link can't be replayed as a Telegram callback even if an attacker knew the link_id. |
| 14 | Cross-channel revocation as a bug | **Safe** | Intended behavior. See I-1. |
| 15 | Audit-log injection via User-Agent | **Safe** | `insertAuditLog` writes UA via `jsonb()` (parameterized, JSON-escaped). No newline/control-char escape into the audit row. |
| 16 | Telegram ack ordering / replay | **Safe** | Ack fires AFTER validation, BEFORE tx — Model A per spec. Telegram's `callback_query_id` expires 15s after delivery, so a duplicate update is harmless. |
| 17 | WhatsApp template injection via owner-edited fields | **Safe** | All dynamic fields go through Twilio Content template variables, not concatenated into the template body. |
| 18 | Telegram enrollment token reuse race | **Likely safe — verify** | I did not read `worker/ingress/telegram-enrollment.ts` directly in this round. Sub-agent flagged a TOCTOU on `/start <token>`; based on the signup-poller TOCTOU pattern documented elsewhere (lab note 2026-04-26) the team is aware of this class of bug, but the specific telegram-enrollment file should be opened in a follow-up to confirm `SELECT … FOR UPDATE` + re-validation. **Action item — not a confirmed finding.** |

---

## Recommended Round-2 fix priority

1. **H-1** — Sanitize `editedText` before storage: strip HTML, reject bidi/zero-width unicode, optionally cap length tighter for unbinned devices. Single chokepoint at `edit/route.ts` or inside `token-mode.ts:edit()`.
2. **M-2** — Make device-bind atomic with `WHERE device_cookie_hash IS NULL` so the second binder fails loudly instead of silently overwriting. Surface a clear "this link was opened from another device" error.
3. **M-1** — Decide channel-specific delivery shape for SMS. Either drop the URL and use a tap-to-confirm mini-page, or shorten SMS expiry to 1–2h. Does NOT need a code change for the MVP if you accept the lock-screen risk + sales-partner-as-gate, but document the trade-off explicitly.
4. **M-3** — Enforce `SESSION_COOKIE_SECRET` minimum length at boot. Two lines.
5. **L-1** — UA allow-list on `/session` POST. Cheap.
6. **I-1, I-2, I-3** — Add code comments / docs noting the design intent. No fix required.
7. **Verify enrollment-token race** (item #18 in Verified Safe table) — open `worker/ingress/telegram-enrollment.ts` in Round 6 (it overlaps with the race-condition round).

---

## Coverage notes

- I did NOT read `src/lib/approval/callback-mode.ts` or `session-mode.ts` end-to-end this round (relied on sub-agent + token-mode.ts cross-references). Worth a follow-up read if you want full coverage.
- WhatsApp inbound handler (`worker/ingress/twilio-whatsapp-inbound.ts`) wasn't directly verified — sub-agent's reading was used. The structural symmetry with telegram-callback.ts and the same enrollment-binding pattern make me confident the same Verified Safe items apply, but a direct read in a future pass would close the loop.
- The CSRF cookie's `Domain` attribute (whether scoped to exact host or `.repworth.net`) was not directly inspected in this round — folded into Round 5's secrets/cookies pass.
