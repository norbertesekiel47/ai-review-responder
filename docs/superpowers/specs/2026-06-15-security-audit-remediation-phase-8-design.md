# Security-Audit Remediation — Phase 8 Design (auth/access fold-ins)

**Date:** 2026-06-15 (executed 2026-06-16)
**Source audit:** `docs/security-audit/2026-06-15-refresh-delta.md` (F-5, F-18, F-19, F-20)
**Roadmap:** Phase 8 — Info / belt-and-suspenders fold-ins.
**Lane:** mixed — F-5 is worker (staging); F-20 is a Next route (preview). One PR.
**Status:** Design approved (owner answered the F-18 + F-19 decisions 2026-06-16).

## 1. Scope & outcomes

| Finding | Sev | Outcome (owner decision 2026-06-16) |
|---|---|---|
| F-5 | INFO | **Implement** — publisher belt-and-suspenders moderation-hold gate (worker). |
| F-20 | LOW | **Implement** — per-admin daily demo-generation cap (route). |
| F-18 | MED | **Document as intentional** — no code change. |
| F-19 | LOW | **Defer with rationale** — no code change. |
| (F-11) | MED | **Record deferral** — fold the Phase 7b deferral rationale into the audit doc + `csp-rollout.md` (knowledge capture; no code). |

## 2. F-5 — Publisher belt-and-suspenders moderation-hold gate (implement)

**Today:** A high-severity moderation flag writes a `flagged_responses` row
(`status='open'`) and leaves the draft at `pending_approval`
(`ResponseGeneratorWorker`). The publishable-state gate
(`ResponsePublisherWorker.ts:66-73`) excludes `pending_approval`, and a flagged
draft never gets a publish outbox row — so this is **non-exploitable today**. But
the moderation veto is only *implicit* on the publish path; nothing there checks
`flagged_responses`. A reusable `hasOpenFlag(tx, responseId)` already exists
(`src/lib/moderation/held-draft.ts:34`) and every **owner-facing** release path
already calls it; the **publisher** does not.

**Fix:** Make the veto binding on the publish path too.

- **New module** `worker/jobs/publisher/held-flag-gate.ts` exporting
  `isHeldForModerationReview(responseId): Promise<boolean>`:
  ```ts
  export async function isHeldForModerationReview(responseId: string): Promise<boolean> {
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM responses WHERE id = ${responseId}::uuid FOR UPDATE`;
      return hasOpenFlag(tx, responseId);
    });
  }
  ```
  The `FOR UPDATE` lock honors `hasOpenFlag`'s contract (serialize against the
  admin disposition that closes the flag). Extracted (not inlined) for three
  reasons: invariant #12 (entry point orchestrates; logic in a named module),
  to keep `handlePublishResponse` under the `ci:fallow` complexity gate, and so
  the worker test mocks it without perturbing the ordered `sqlReturnQueue`.

- **Worker change** (`ResponsePublisherWorker.ts`): add the gate **after the
  subscription guard (line 114), before the Zernio connection load (line 116)** —
  i.e. after all other non-spend "don't publish" gates, before any external call:
  ```ts
  if (await isHeldForModerationReview(response_id)) {
    logger.warn(`Response ${response_id} has an open moderation flag; refusing to publish (F-5).`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }
  ```
  `markOutboxCompleted` (not `Failed`) mirrors the sibling gates (offboarding,
  non-publishable-state, archived, subscription-blocked): an open flag is a
  legitimate "don't publish" decision, not a job failure. `logger.warn` because
  reaching here at all is an anomaly worth surfacing.

**Tests:**
- `held-flag-gate.test.ts` (new): mock `sql.begin` + `hasOpenFlag`; assert it
  takes the `FOR UPDATE` lock and returns `true`/`false` per `hasOpenFlag`.
- `ResponsePublisherWorker.test.ts` (extend): `vi.mock('../held-flag-gate')`
  defaulting to `false` (existing tests unaffected); add a case where it returns
  `true` → asserts `markOutboxCompleted` called and `postReply` NOT called.

## 3. F-20 — Per-admin daily demo-generation cap (implement)

**Today (`src/app/api/admin/demos/generate/route.ts:40-56`):** global cap
`demo:generate:daily` 50/day + per-IP `demo:generate:minute:<ip>` 5/min. No
per-admin cap, so one admin can consume the whole global 50/day. The route is
AAL2-gated (`requireAdminWithAal2`), and the gate returns the admin as
`gate.admin` (`{ ok: true; admin: AppUser }`); `gate.admin.id` is the admin user id.

**Fix:** Add a per-admin daily cap **between** the global daily cap (line 47) and
the per-IP minute cap (line 49), inside the existing `try` (so a Redis error still
fails closed → 503, matching the route's cost-sensitive posture):
```ts
const adminDailyLimit = await checkRateLimit(`demo:generate:daily:admin:${gate.admin.id}`, 20, 86400);
if (!adminDailyLimit.allowed) {
  return NextResponse.json({ error: 'Per-admin daily demo limit reached (20/day)' }, { status: 429 });
}
```
Cap = **20/day per admin** (< the global 50; generous for legitimate demo use;
adjustable). Mirrors Phase 6 F-21 (reuse `checkRateLimit`, no new dependency).

**Tests (`route.test.ts`, extend):**
- per-admin cap exhausted → 429 (`{ allowed:false }` on the per-admin call).
- existing per-IP-exhausted test: update the `checkRateLimit` mock chain to
  account for the new call order (daily → per-admin → per-IP).
- the per-admin key includes `gate.admin.id`.

## 4. F-18 — Document the per-route read gate as intentional (no code)

**Decision:** The subscription **read** branching in `dashboard/route.ts`
(pending→pay CTA, cancelled→grace read, past_due→recovery+data, active→normal)
is per-route **by design** — each route renders a different *product state* per
subscription status; it is not a uniform security gate. The security-relevant
**write** access is already centrally gated (`requireWritableOwner` →
`assertWritableSubscriptionForAccount`). Centralizing the read gate would either
flatten the per-route UX or add a `subscription_status` DB read to every
protected request in `src/proxy.ts` for no security gain.

**Action:** Record this rationale in the audit doc F-18 row (status → "ACCEPTED —
per-route read model is intentional; write gates centralized"). Verify-spec-style
note; no code change.

## 5. F-19 — Defer with rationale (no code)

**Decision:** `signup-status` is a **self-referential** oracle — it queries
`WHERE u.auth_id = <session user>` and `session_id` only reconciles the caller's
*own* account (`route.ts:142-152,160-177`). It reveals only the caller's own
signup state (no cross-user enumeration). Unifying 401/404/200 → `200 {state}`
would require refactoring `PaymentSuccessClient`'s hard-redirect-on-401/403 logic
in the critical post-payment polling flow for negligible security gain.

**Action:** Record in the audit doc F-19 row (status → "DEFERRED — self-referential
oracle; negligible value vs. risk to the payment-success polling flow"). No code.

## 6. F-11 — Record the Phase 7b deferral (no code, knowledge capture)

Fold the Phase 7b finding into the audit doc F-11 row + `csp-rollout.md`: enforcing
a script-src nonce breaks hydration on 39 statically-prerendered pages (per-request
nonce ⊥ build-time static HTML); `force-dynamic` is the validated fix but trades
away static/CDN prerendering app-wide; deferred pending that architectural call.
`style-src 'unsafe-inline'` also can't be nonced (346 inline style attributes).

## 7. Verification gate (before PR)

`pnpm lint` (+ `npx eslint worker/jobs/publisher/...` for the worker files — `pnpm
lint` is `eslint src` only) · `pnpm typecheck` · `pnpm test` · `pnpm ci:fallow` ·
`pnpm ci:static-policy` · `pnpm ci:tenant-scope` · `pnpm ci:rls-audit` · `pnpm
build`. Then PR → watch CI to green.

## 8. Review

- F-5 (worker, security-sensitive moderation veto): spec-compliance + code-quality
  review.
- F-20 (mechanical mirror of F-21): controller verifies the diff.
