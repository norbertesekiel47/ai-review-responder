# Round 3 — Webhook Ingress & Signature Verification

**Audit date:** 2026-04-26
**Scope:** All seven Fastify worker webhook endpoints (`/ingress/stripe`, `/resend`, `/twilio/{status,inbound}`, `/twilio/{whatsapp-status,whatsapp-inbound}`, `/telegram`) + the `inbound_events` dedup primitive + signature-verify helpers.
**Methodology:** Whitebox source review. Two parallel sub-agents followed by direct verification of every Critical/High claim against the actual source. The most explosive finding (MOCK bypass) was confirmed by reading the verify functions and the startup-assert module side-by-side — the agents' framing held up.

**Severity rubric:** Critical = unauthenticated state mutation in prod. High = signature bypass under realistic operator-error conditions. Medium = replay/race window or operational hardening with concrete impact. Low = misconfig opportunities. Informational = design notes.

---

## Findings (by severity)

### [HIGH] H-1: `MOCK_EXTERNAL_APIS=true` silently disables signature verification on Twilio AND Resend webhooks

- **Location:**
  - `worker/ingress/twilio-verify.ts:28-39` — Twilio verify returns `true` when `MOCK_EXTERNAL_APIS=true` AND `TWILIO_AUTH_TOKEN` is unset
  - `worker/ingress/resend.ts:24-34` — Resend verify returns `true` when `MOCK_EXTERNAL_APIS=true` AND `RESEND_WEBHOOK_SECRET` is unset
  - `worker/startup-assert.ts:33, 54, 76` — every channel assertion early-returns when `MOCK_EXTERNAL_APIS=true`, so a prod deployment with mock mode on never validates that Twilio/Telegram/WhatsApp secrets are set
- **Description:** Two operator mistakes, each common, combine into a full-bypass: (a) `MOCK_EXTERNAL_APIS=true` accidentally set in production (CI typo, copied env block from a staging template, leftover from a debugging session); (b) the corresponding signature secret is missing or got cleared during a key rotation. Either failure mode alone is harmless, but together the worker accepts any request to `/ingress/twilio/*`, `/ingress/resend`, `/ingress/twilio/whatsapp-*` with no signature check at all. The startup assertions that would normally catch the missing secret are themselves gated behind the same flag, so neither catches the other.
- **Impact:** Any internet-reachable IP can POST to `/ingress/twilio/inbound` and forge an SMS STOP from any phone number, opting that number out of all RepWorth notifications. Or POST to `/ingress/resend` with a forged hard-bounce payload to flag any business's owner email as bouncing, killing their notification stream. Or POST to `/ingress/twilio/whatsapp-inbound` with a `ButtonPayload=a:<known-link-uuid>` to trigger an approval — combined with R2 H-1 (sanitization gap on `editedText`), this enables silent forged response publication. The probability that BOTH variables are misset simultaneously in prod is low but the cost of detecting + recovering after the fact is high (forged opt-outs are TCPA-recordable; forged approvals publish text to Google).
- **Proof of concept:** (1) Operator sets `MOCK_EXTERNAL_APIS=true` in Railway env (e.g., copying from staging template). (2) `TWILIO_AUTH_TOKEN` is unset (intent: "mock mode doesn't need Twilio"). (3) Worker boots — `assertChannelsSmsEnv` early-returns, no error. (4) Attacker POSTs `/ingress/twilio/inbound` with form-urlencoded body `From=%2B15555550100&Body=STOP&MessageSid=SM00000000000000000000000000000000`. (5) `verifyTwilioSignature` returns `true` (no auth token + mock mode). (6) Inbound handler processes STOP → unsubscribes the number from all enrollments. Repeat for any victim phone.
- **Recommended fix:** **Multi-layer defense — do all of these.** (a) In `worker/index.ts` startup, hard-fail if `NODE_ENV === 'production' && MOCK_EXTERNAL_APIS === 'true'`. The bypass should never be reachable in production. (b) Remove the `MOCK_EXTERNAL_APIS` early-return from `assertChannelsSmsEnv` / `assertChannelsTelegramEnv` / `assertChannelsWhatsAppEnv` — instead, require the secrets unconditionally when the channel flag is on (mock mode can use a literal `mock_token` sentinel value the verify function recognizes only in non-prod). (c) In `verifyTwilioSignature` and `verifySignature` (resend), check `NODE_ENV` explicitly: `if (process.env.NODE_ENV === 'production') return false;` before the mock branch. Belt + suspenders.

---

### [HIGH] H-2: Stripe webhook secret + payment-link envs are not asserted at boot — silent failure window

- **Location:** `worker/startup-assert.ts` (no `assertStripeEnv` exists); `worker/ingress/stripe.ts:208-213` (secret checked only at request time)
- **Description:** Unlike SMS/Telegram/WhatsApp/Self-serve-signup, there is no `assertStripeEnv()` function. If `STRIPE_WEBHOOK_SECRET` is missing or misconfigured, the worker boots cleanly and the first incoming webhook returns 401. Stripe retries for ~3 days. Meanwhile, every `checkout.session.completed` event for paying customers is rejected — owners pay but their `subscription_status` never flips to `active`, blocking notifications/publishing. Detection requires noticing the missed activations (potentially hours/days later).
- **Impact:** Revenue + activation outage with no early-warning. Not a security exposure per se, but a security-adjacent operational risk that lives in the same module. Once `STRIPE_SECRET_KEY` is also missing, even support code paths that try to read Stripe state silently fall over.
- **Recommended fix:** Add `assertStripeEnv()` in `startup-assert.ts` checking `STRIPE_WEBHOOK_SECRET` and `STRIPE_SECRET_KEY` are set non-empty (unconditionally — Stripe is core to billing, not a feature flag). Call it from `worker/index.ts:main()` before BullMQ worker registration.

---

### [MEDIUM] M-1: `WORKER_PUBLIC_URL` trailing slash silently breaks Twilio signature verification

- **Location:** `worker/ingress/twilio.ts:21-23` (`fullUrl(request)`); analogous concat in `worker/ingress/twilio-whatsapp-*.ts`
- **Description:** `fullUrl()` returns `${process.env.WORKER_PUBLIC_URL}${request.url}`. If `WORKER_PUBLIC_URL` is set with a trailing slash (e.g., `https://worker.repworth.app/`), the result is `https://worker.repworth.app//ingress/twilio/status`. Twilio computes the signature against the URL **as registered in the Twilio console** — if you registered `https://worker.repworth.app/ingress/twilio/status` (single slash), the signatures will NOT match, and EVERY legitimate Twilio webhook will be rejected with 401. This is a legitimate-traffic outage — not an attacker bypass. (For an attacker bypass to exist, Twilio would have to sign against the same double-slashed URL the worker reconstructs, which requires the Twilio console URL itself to have been registered with a double slash — a separate operator error that would be noticed immediately.)
- **Impact:** Entire SMS + WhatsApp delivery telemetry stream silently fails — every status update bounces with 401, all `notification_deliveries` rows stay in non-terminal state, NotificationFailoverPoller eventually re-fires, generating a duplicate-email storm before someone notices. The bug only manifests after any human edits the env var, so it can lurk for weeks before being triggered.
- **Recommended fix:** Normalize `WORKER_PUBLIC_URL` once at boot: `process.env.WORKER_PUBLIC_URL = process.env.WORKER_PUBLIC_URL?.replace(/\/+$/, '')`. Add a startup assertion that the value matches `^https://[^/]+$` exactly (no path component, no trailing slash). Pair with H-1's recommendation to assert `https://` prefix.

---

### [MEDIUM] M-2: Stripe webhook handler does not reject stale events via `event.created` timestamp

- **Location:** `worker/ingress/stripe.ts:228` (claimInboundEvent dedup) — no `event.created` check anywhere
- **Description:** `inbound_events` dedup correctly prevents the same `event.id` from being processed twice. But there is no check on `event.created` (the Stripe-set timestamp inside the signed payload). If someone obtains a valid old Stripe webhook payload (from an archived log, a leaked test capture, an old GitHub commit) and the corresponding `inbound_events` row was archived/pruned, replaying it now would succeed (signature still valid; dedup row no longer exists). Resend's verify already enforces a 5-minute window — Stripe doesn't.
- **Impact:** Currently bounded — `inbound_events` is not auto-pruned per `CLAUDE.md`'s "Archival" reference, so old dedup rows persist. The risk activates the day a retention/archival job is added without coordinating with the Stripe handler. Defense-in-depth gap.
- **Recommended fix:** After signature verification + before `claimInboundEvent`, reject any event where `event.created < (now - 1h)`. Return `200 { stale: true }` so Stripe stops retrying. Cheap to add now.

---

### [MEDIUM] M-3: `inbound_events` 2-minute reclaim window can double-process slow handlers

- **Location:** `worker/ingress/shared.ts:35-42`
- **Description:** A row stuck in `status='received'` for >2 minutes is reclaimable by another worker. If a handler takes longer than 2 minutes to complete (slow LLM call, DB lock contention, network retry storm), a second worker reclaims and re-processes the same event. For approval-callback handlers this means a duplicate `approve` mutation; for status-callback handlers it means a duplicate delivery row UPDATE — those individual operations are idempotent (status flips are state-machine bound), so the impact today is low. But the worst case is a Telegram callback that triggers `approveViaCallback` twice in different worker processes, with the second one executing AFTER the response transitioned past `pending_approval` — `lockPendingResponse` correctly throws `ResponseNotPendingError` in that branch, so it's caught.
- **Impact:** Bounded by the application-layer idempotency that already exists. Becomes high-impact if (a) the 2-min window is ever shortened, (b) a new handler is added that mutates non-idempotently (e.g., a future SMS-cost-charging hook), or (c) DB latency starts pushing legitimate handlers past the 2-min window during incidents.
- **Recommended fix:** Either (a) raise the reclaim window to 10 minutes (handlers should be sub-second; 10 min is generous), or (b) when a worker claims an event, set `received_at = NOW() + 5min` so it owns a clear lease, refreshing on long operations. Pair with monitoring on max handler duration.

---

### [MEDIUM] M-4: WhatsApp `ButtonPayload` parser does not bound length or reject control characters

- **Location:** `worker/ingress/whatsapp-shared.ts:33-43` (per sub-agent report — line numbers not directly verified)
- **Description:** `parseButtonPayload()` accepts arbitrary string content as long as it has the `a:`/`r:` prefix and a UUID-shaped suffix. Trailing junk (newlines, control chars, oversized payload) is silently ignored — the UUID lookup proceeds. Today the impact is bounded because the lookup is by exact UUID match against `approval_links.id`, so junk doesn't change the query result. But the same payload string flows into log lines and audit metadata, and a `ButtonPayload=a:<uuid>\n[FAKE LOG ENTRY]` could pollute log parsing or alert-channel output that doesn't sanitize.
- **Impact:** Log injection and alert-channel pollution under operator-tooling assumptions. Not exploitable for state mutation.
- **Recommended fix:** Add explicit validation: `if (payload.length > 38) return null` and reject any non-UUID-charset characters after the prefix. One-liner in the parser.

---

### [LOW] L-1: No rate limit on `/ingress/*` endpoints

- **Location:** `worker/index.ts` (Fastify route registration)
- **Description:** None of the seven webhook endpoints have a per-IP rate limit. Signature verification fires before `claimInboundEvent` (good), so a flood of bad-signature requests doesn't write rows to `inbound_events`, but each request still costs CPU (HMAC verify ~ microseconds) plus a DB round-trip in the few cases where signature verification needs to look something up.
- **Impact:** Cost-DoS / CPU-exhaustion vector. Real attack requires high request volume (10k+ rps) to materially impact performance. Railway autoscaling absorbs most of it but at $$ cost.
- **Recommended fix:** Add a simple Redis-backed token bucket on `/ingress/*` paths (e.g., 100 req/s per IP) before signature verification. Re-use `src/lib/shared/rate-limit.ts`.

---

### [LOW] L-2: `WORKER_PUBLIC_URL` not asserted to start with `https://`

- **Location:** `worker/startup-assert.ts` (no such check)
- **Description:** Operator could configure `WORKER_PUBLIC_URL=http://...` (e.g., when wiring up against a local-tunnel during development) and accidentally deploy. If Railway terminates TLS upstream at the edge and the worker computes signature URLs as `http://`, Twilio's signing won't match (since Twilio always uses what's registered in the console).
- **Recommended fix:** Add `if (process.env.WORKER_PUBLIC_URL && !/^https:\/\/[^/]+$/.test(process.env.WORKER_PUBLIC_URL)) throw …` in startup-assert. Folds into M-1's normalization fix.

---

### [LOW] L-3: SMS inbound handler logs full phone number; WhatsApp masks it (inconsistency)

- **Location:** `worker/ingress/twilio.ts` (~line 251 per sub-agent — verify); `worker/ingress/twilio-whatsapp-inbound.ts` masks `From` to last 4 digits
- **Description:** Two inbound handlers, two PII policies. SMS logs `From=+15555550100` raw; WhatsApp logs `From=...0100`. Cloudwatch / Railway log aggregation captures both. Inconsistency means an operator-side reader can extract phone numbers from one stream but not the other.
- **Impact:** PII drift in logs. Not a primary leak channel since Sentry breadcrumbs already scrub (per worker/index.ts:6-21 per sub-agent), but plain stdout reaches log aggregation.
- **Recommended fix:** Apply the WhatsApp masking pattern to SMS — single helper `maskPhone(num)` in `worker/ingress/shared.ts`, called by all phone-emitting log lines.

---

### [INFORMATIONAL] I-1: Stripe `client_reference_id` business binding is safe in current architecture but gets fragile if Payment Link URLs become customer-customizable

- **Location:** `worker/ingress/stripe.ts:34-56` (`processCheckoutSessionCompleted`)
- **Description:** Today, `client_reference_id` is set by RepWorth's own onboarding flow when constructing the Payment Link URL, and Stripe signs the entire event so it can't be tampered. Sub-agent noted this would become a real concern if a future flow lets the customer construct their own Payment Link URL with arbitrary `client_reference_id`. Worth tracking as an architecture invariant.
- **Action:** Add a code comment near `processCheckoutSessionCompleted` calling out that `client_reference_id` is server-set and any future flow that lets customers influence it must add a metadata-binding check.

---

### [INFORMATIONAL] I-2: WhatsApp STOP unsubscribes globally (handle-wide), not per-business — by design

- **Location:** `worker/ingress/twilio-whatsapp-inbound.ts:180-196` (per sub-agent)
- **Description:** STOP from a WhatsApp number unsubscribes that handle from EVERY business it's enrolled in, not just the most recent. This is correct TCPA semantics (sender-wide opt-out is the legal standard) but is implicit in the SQL (no `business_id` filter in the UPDATE). Document explicitly so a future "per-business preferences" feature doesn't quietly contradict the TCPA invariant.
- **Action:** Code comment.

---

### [INFORMATIONAL] I-3: Twilio status webhook terminal-state precedence is enforced via partial UPDATE WHERE — not via dedup key

- **Location:** `worker/ingress/twilio.ts:84-131`
- **Description:** Dedup key `${MessageSid}:${MessageStatus}` allows separate dedup rows per status transition (intentional — each transition is a real event). The terminal-state precedence (e.g., a late `delivered` doesn't overwrite an earlier `failed`) is enforced inside the UPDATE statement (`WHERE delivered_at IS NULL AND failed_at IS NULL`), not at the dedup layer. Currently safe, but anyone tweaking the dedup logic could break terminal-state semantics without a clear test.
- **Action:** Add a comment at `twilio.ts:80-90` explicitly naming the invariant ("First terminal status wins; later transitions are silently ignored at the UPDATE WHERE clause").

---

## Verified safe (claims investigated, no finding)

| # | Claim | Status | Reason |
|---|---|---|---|
| 1 | Stripe signature verification before business logic | **Safe** | `stripe.webhooks.constructEvent(rawBody, sig, secret)` at `stripe.ts:217` is the first business-meaningful operation; no DB writes precede it. |
| 2 | Raw body preserved (not JSON-reparsed) | **Safe** | Fastify `rawBody` plugin registered globally with `global: false`, opted in per-route via `config: { rawBody: true }`. Both Stripe + Resend routes opt in correctly. |
| 3 | Stripe response codes correct (401 on bad sig, 500 on transient) | **Safe** | Stripe stops retrying on 401 (correct — bad sig is permanent), retries on 500. Verified at `stripe.ts:198-222, 267-278`. |
| 4 | Resend timestamp window enforcement | **Safe** | `resend.ts:44-53` rejects `ageSeconds > 300 || ageSeconds < -60` (5min past + 1min skew). Standard Svix-recommended window. |
| 5 | Resend signature compared with `timingSafeEqual` | **Safe** | `resend.ts:64-70` uses `crypto.timingSafeEqual` on base64-decoded buffers. |
| 6 | Resend dedup via `svix-id` | **Safe** | Per-event dedup; if Resend retries with a new `svix-id` for the same logical event (per Svix spec they shouldn't), the new id gets its own row — symmetrical with Stripe. |
| 7 | Resend bounce handler scopes to `business_id` correctly | **Safe** | Lookup via `notification_deliveries.external_message_id` (Resend-controlled, not attacker-controlled). Flag updates only owner-directed templates per `resend.ts:271-297` (per sub-agent). |
| 8 | Resend bounce email lookup case-normalization | **Safe** | Lookup via `external_message_id` not by email value, so case sensitivity is moot. |
| 9 | `/api/admin/payment-success` is a redirect target, not a Stripe webhook | **Safe** | Authenticated admin route, polls `inbound_events` for the session — no signature check needed because it's not receiving webhooks. |
| 10 | Telegram secret-token compared with `timingSafeEqual` | **Safe** | `telegram-verify.ts:9-16` uses `crypto.timingSafeEqual`. Constant-time. |
| 11 | Telegram webhook secret asserted at boot (when flag on) | **Safe** | `assertChannelsTelegramEnv` (`startup-assert.ts:52-60`) checks `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`. **Caveat:** the same `MOCK_EXTERNAL_APIS=true` early-return applies — included under H-1. |
| 12 | Twilio inbound STOP forgery requires signature bypass | **Safe (modulo H-1)** | `verifyTwilioSignature` runs before any DB write or state mutation. Without the H-1 mock-mode bypass, attacker can't forge. With H-1, they can. |
| 13 | Twilio status terminal-state precedence | **Safe** | First-wins via UPDATE WHERE clause — see I-3. |
| 14 | WhatsApp template injection via owner-edited fields | **Safe** | Twilio Content templates take variables not template-string interpolation; injection in the body has no template-engine surface. |
| 15 | Telegram callback chat_id binding | **Safe** | Sender chat_id (`cb.from.id`) is included in the signed update; not externally forge-able without the webhook secret. Enrollment lookup is `business_id = ${link.business_id} AND handle = ${senderId}` (R2 verified). |
| 16 | Telegram enrollment FOR UPDATE wrapped in tx | **Safe** | Sub-agent confirmed `sql.begin()` wrapping; the row lock survives the SELECT-then-UPDATE. **Note:** the invariant is fragile — a comment explicitly stating it would help. (Not directly verified by me — Round 6 will re-check this and the cleanup poller TOCTOU.) |
| 17 | Worker `/api/health` reveals env vars | **Safe** | Returns `{status: 'ok', timestamp: ...}` only. |
| 18 | inbound_events status transitions get stuck | **Safe** | Crash before `markProcessed` leaves status `received`; reclaim picks up after 2 min. No stuck states under normal failure modes. |

---

## Recommended Round-3 fix priority

1. **H-1** — Hard-fail at boot if `NODE_ENV === 'production' && MOCK_EXTERNAL_APIS === 'true'`. Single line in `worker/index.ts`. Then remove the `MOCK_EXTERNAL_APIS` early-returns from the channel asserts so secret presence is enforced unconditionally when the flag is on. Optional belt-and-suspenders: gate the verify-function bypass to `NODE_ENV !== 'production'` too.
2. **H-2** — Add `assertStripeEnv()` and call it at startup. Five-line change.
3. **M-1 + L-2** — Normalize `WORKER_PUBLIC_URL` (strip trailing slash, assert `https://` prefix, no path) at startup. One assertion covers both.
4. **M-2** — Add `event.created` 1h staleness check in Stripe handler.
5. **M-3** — Decide reclaim policy: raise window to 10 min OR add lease-extension. Monitor handler durations first.
6. **M-4** — Bound `parseButtonPayload` length + charset.
7. **L-1** — Rate limit `/ingress/*`.
8. **L-3** — Mask SMS inbound `From` consistently with WhatsApp.
9. **I-1, I-2, I-3** — Comments only.

---

## Coverage notes

- I read `twilio-verify.ts`, `resend.ts` (head), `twilio.ts` (head), `shared.ts`, `startup-assert.ts`, `telegram-callback.ts` (Round 2 carryover), and the worker entry indirectly via the agents' references. I did NOT directly read `whatsapp-shared.ts`, `twilio-whatsapp-inbound.ts`, `twilio-whatsapp-status.ts`, or `telegram-enrollment.ts` end-to-end this round — sub-agent findings on those files are taken at face value but should be re-verified if any becomes a fix priority.
- The Telegram enrollment race (item #16 in Verified Safe) deserves a direct read in Round 6 since that round covers race conditions specifically.
