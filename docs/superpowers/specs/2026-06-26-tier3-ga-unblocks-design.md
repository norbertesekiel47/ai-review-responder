# Tier-3 GA Unblocks — Design

- **Date:** 2026-06-26
- **Branch:** `tier3-ga-unblocks` (sibling worktree, base `origin/main`)
- **Issues:** #291, #355, #134, #289, #290 (Tier 3 — Revenue/product unblocks, lead-time sensitive)
- **Status:** approved (brainstorm 2026-06-26)

## 1. Context & framing

These five issues are a **batch of GA-unblock items**, not one feature. Four are
operational; one (#355) is the only pure code change. The work therefore splits
across **two execution surfaces**:

- **PR surface** — committed to `tier3-ga-unblocks`, runs the full pipeline
  (TDD → verify gate → Codex correctness review → thermo-nuclear maintainability
  review → PR with green CI incl. React Doctor). Contains the #355 code change
  plus four prepared docs/artifacts.
- **Ops surface** — executed live via MCP (Railway/Vercel/Supabase). Every
  **prod** mutation is gated on explicit owner approval; only **staging**
  mutations are autonomous.

#288 (apply migration 064 to prod) is **already closed/verified** (column present,
backfill parity exact, 2026-06-26) — so the SELF_SERVE_SIGNUP migration
prerequisite in #289 is cleared.

## 2. Goals / non-goals

**Goals**
- Ship the #355 instrumentation (durable 400 logging) and, when the real
  `body.code` is captured, the disposition fix + regression test.
- Produce execution-ready artifacts for #134/#289/#290/#291 the owner runs.
- Drive the staging-only ops (deploys, env, capture, readiness reads) via MCP.

**Non-goals**
- No **prod** flag flips, prod env changes, Google-form submission, or PostHog
  UI building performed autonomously — those are owner actions.
- No blind guess of the #355 400 disposition. If the staging capture stalls, the
  PR ships instrumentation-only and the fix is a fast-follow.

## 3. Per-issue deliverables

### #355 — Zernio delete-reply HTTP 400 (code; TDD; two passes, one branch)

**Root cause (confirmed in code):**
- `src/lib/zernio/client/error-classifier.ts:85-94` — for every endpoint except
  `select_location`, a 400 is hardcoded `ZernioPermanentError('http_400', { status, body, endpointKind })`.
  The `body` (with `body.code`) **is captured** in the error meta.
- `worker/jobs/publisher/edit-publish.ts:98-105` `isDeleteAlreadyGone()` rescues
  **only** `http_404`/`delete_reply` as DELETE-success; a 400 has no rescue.
- `worker/jobs/publisher/edit-publish-errors.ts:312-331` `handleDeleteError()` —
  `ZernioPermanentError` branch marks the candidate `failed` with
  `posting_error = deleteFailedMarker('http_400')` → `permanent_failed`
  → outbox `zernio_permanent_after_edit_publish` (attempts 1/5, not retried).

**Pass 1 — instrument (ships regardless).** In `handleDeleteError`'s
`ZernioPermanentError` branch, emit a durable structured `logger` line for the
`http_400` / `delete_reply` case carrying `err.kind`, `err.meta.status`, and a
bounded `err.meta.body` (Zernio API error metadata only — **no review/response
text**, per the logging rule; body is API JSON, not customer content). Surfaces
the datum on the staging worker log where Sentry is off.
- Unit test: given `ZernioPermanentError('http_400', { status:400, body:{ code:'X' }, endpointKind:'delete_reply' })`,
  `handleDeleteError` emits a log line containing the code, and still returns
  `permanent_failed` (behavior unchanged in Pass 1).

**Capture.** Deploy the Pass-1 commit to the **staging worker** via Railway MCP.
Recreate the repro (see Risk 1), click **Retry posting**, read `body.code`.

**Pass 2 — fix (disposition-dependent).**
- *"reply not found / nothing to delete"-class code* → extend
  `isDeleteAlreadyGone` (edit-publish.ts) — or add a `delete_reply` 400 branch in
  the classifier mirroring the `select_location` `PRE_MUTATION_400_CODES`
  default-deny allowlist — to treat that specific allowlisted code as
  DELETE-success, then proceed to POST.
- *"malformed request / bad identifier"-class code* → fix the `deleteReply`
  request shape in the Zernio adapter (`src/lib/publishing/zernio-review-publisher.ts`
  / the zernio client `deleteReply`).
- Regression test for the chosen disposition (delete-400 → edit-publish proceeds
  correctly; unknown 400 codes stay permanent — default-deny).

**Fallback (decided):** if the staging capture stalls this session, the PR ships
**Pass 1 only** (a genuine robustness improvement); Pass 2 is a separate
fast-follow PR once the code is captured. Never guess the disposition blind.

### #134 — WhatsApp single-location canary (mostly ops; doc + verification)

Code blockers (#132/#133/#135) already landed on `main`; remaining is ops.
Variable map in `formatApprovalWhatsApp` (`src/lib/notifications/channels/whatsapp-body.ts:142-160`)
confirmed positional `{{1}}`–`{{9}}`: businessName, reviewerName, starRating,
reviewDate, reviewText, responsePreview(draft), `a:`linkId, `r:`linkId, token.

- **Variable-map validation gate:** diff the approved Twilio template's `{{1}}`–`{{9}}`
  against the renderer (no runtime re-mapping — positional). Record result.
- Record the approved `HX…` Content SID in `docs/runbooks/whatsapp-templates.md`.
- Set the 7 env vars on **staging** (Vercel UI+routes and Railway worker) via MCP:
  `CHANNELS_WHATSAPP_ENABLED`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_WHATSAPP_NUMBER`, `WHATSAPP_APPROVAL_TEMPLATE_SID`,
  `WHATSAPP_APPROVAL_URL_BASE` (= `NEXT_PUBLIC_APP_URL + '/approve/'`),
  `NEXT_PUBLIC_APP_URL` (+ `WORKER_PUBLIC_URL` on Railway).
- Run the **8-point ship gate** (runbook §"Eight-point ship gate") single-location.
- **Prod flag flip is the owner's call** (not autonomous).
- **Owner input needed at execution:** the `HX…` SID.

### #289 — Launch-flag readiness gate (doc)

A per-flag readiness table grounded in **live state** verified via MCP, for the 7
flags in the issue (SELF_SERVE_SIGNUP_ENABLED, OPENAI_MODERATION_ENABLED,
MFA_ENFORCEMENT_ENABLED, MULTI_LOCATION_ENABLED, CHANNELS_WHATSAPP_ENABLED,
CHANNELS_TELEGRAM_ENABLED, RANKING_TRACKING_ENABLED). Each row: prerequisite,
current verified status (green/blocked + evidence), and the flip action. The
owner flips each **prod** flag; nothing is flipped autonomously. Committed as a
**new dedicated runbook** `docs/runbooks/launch-flag-readiness.md` (kept separate
from the in-flight `docs/launch-checklist.md` edits to avoid entanglement).

### #290 — Production PostHog dashboard spec (doc)

A runbook mapping the 4 launch dashboards to the **actual** event names/properties
emitted in `src/lib/analytics`, with exact insight definitions:
- Activation funnel
- Approval-loop latency
- Channel health
- Cost guardrails

Owner builds them in the PostHog UI (no PostHog MCP available). Committed as a
new runbook `docs/runbooks/posthog-launch-dashboards.md`.

### #291 — GBP API filing guide (doc)

A short fire-and-forget checklist (what to enter, where) so the owner submits the
Google Business Profile API application today and starts the multi-week clock.
Owner files it. Committed as a new doc `docs/runbooks/gbp-api-application.md`.

## 4. Branch / PR strategy

One branch, logically-grouped commits, one PR to `main`. The #355 worker change
**rides staging first** (project rule for worker changes) — that staging deploy is
the same one used for the 400 capture. After merge, fast-forward `staging` onto
`main`. React Doctor should be trivially green (no React touched — worker code +
markdown docs).

## 5. Risks

1. **Staging DB was cleaned today** ("only admin account remains", 5:41p) — the
   2026-06-20 orphan response is almost certainly gone, so capturing the 400
   likely needs a **fresh repro** (ingest → draft → approve → post → edit+republish
   ~60s later) with staging Zernio sandbox wired. Mitigation: Pass-1 ships
   regardless; Pass-2 fast-follows.
2. **Prod mutations** (#134 flag/env, #289 flips) are owner-gated — only staging
   is autonomous.
3. **Meta resubmission clock** — any wording/button/URL/variable-order change in
   the WhatsApp template restarts the 1–5 business-day Meta review. The renderer
   already matches the approved submission; the gate only re-confirms, never edits.

## 6. Division of labor

| Surface | Who | Items |
|---|---|---|
| Code + docs (PR) | Claude | #355 instrument+fix+tests; #289/#290/#291 docs; #134 runbook+gate |
| Staging ops (MCP, autonomous) | Claude | #355 staging deploy+capture; #134 staging env+ship gate; #289 readiness reads |
| Credentialed / irreversible | Owner | File GBP form (#291); build PostHog dashboards (#290); all **prod** flips & env (#134/#289); provide HX SID |

## 7. Acceptance criteria

- #355 Pass-1 instrumentation merged with a passing unit test; Pass-2 fix +
  regression test merged when the 400 code is captured (else fast-follow issue
  filed with the captured-code dependency noted).
- #134 variable-map gate run + recorded; HX SID recorded; staging env set;
  8-point ship gate executed single-location; prod-flip checklist handed to owner.
- #289 per-flag readiness gate doc committed with live-verified statuses.
- #290 PostHog dashboard spec doc committed, mapped to real events.
- #291 GBP filing guide committed; owner notified it's ready to file.
- Verify gate green: `pnpm lint && pnpm typecheck && pnpm test`
  (+ `pnpm ci:tenant-scope && pnpm ci:rls-audit` if DB-touching).
- All GitHub CI checks green on the PR, incl. 100/100 React Doctor.
