# Step 6 — Codex adversarial review (branch diff vs main)

Date: 2026-07-20 · Verdict returned: needs-attention (1 finding).

## Finding (medium): maxNetworkRetries:0 still allows one retry on ECONNRESET/EPIPE
File: src/lib/accounts/tier-change.ts:374 (STRIPE_UNDER_LOCK_REQUEST_OPTIONS).

Claim: stripe-node 22.2.0 `RequestSender._shouldRetry` retries once on a
connection-closed error on the first attempt before honoring maxNetworkRetries:0,
so a bounded call can make a second attempt → worst-case lock hold > claimed ~24s
(Codex estimated ~48s), "no-ship".

## Verification (against installed SDK source)
- CONFIRMED: RequestSender.js:155-160 — `if (error && numRetries===0 &&
  CONNECTION_CLOSED_ERROR_CODES.includes(error.code)) return true;` runs BEFORE the
  `numRetries >= maxRetries` guard (line 162). So maxNetworkRetries:0 is not a hard
  single-attempt guarantee.
- CONNECTION_CLOSED_ERROR_CODES = ['ECONNRESET','EPIPE'] (HttpClient.js:30).
- Timeout path (the TARGET scenario) uses makeTimeoutError → code=TIMEOUT_ERROR_CODE
  (HttpClient.js:22-25), which is NOT in that list → a hung provider does NOT retry:
  exactly one 8s attempt.
- A reset fails fast (not an 8s wait); the single extra attempt is itself ≤8s.
  Realistic worst-case lock hold ≈ 26s, not ~48s.

## Triage (receiving-code-review) — owner decision 2026-07-20: "ship + correct invariant"
| Sub-claim | Verdict | Action |
|---|---|---|
| maxNetworkRetries:0 ≠ hard no-retry guarantee | ACCEPT | Corrected code comment + intake invariant + plan (accurate ~26s, ETIMEDOUT vs ECONNRESET). |
| Worst case ~48s / "no-ship" | REJECT | Overstated: timeouts don't retry; resets fail fast. Real worst ~26s; goal (bound hung provider) met. |
| Add "assert no 2nd request on ECONNRESET" regression test | REJECT | Would assert a FALSE invariant (SDK genuinely retries there) and fail. |
| Add hard wall-clock deadline (Promise.race/AbortController) | REJECT | Exceeds LOCKED minimal-fix; ~2s gain over 26s. Documented as considered+rejected. |

No production-code behavior change from this finding; docs/comment corrected for
accuracy. Gate re-run after edits (step 5).
