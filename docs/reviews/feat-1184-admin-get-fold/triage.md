# feat/1184-admin-get-fold — review triage

Round 1 wave, dispatched at merge-base `e8893544` / HEAD `fa2e6e34`, gate green.
Four axes: spec & correctness, standards & maintainability (production diff 1,246
lines, over the 300-line threshold, and RISK = high mandates it anyway),
adversarial approach (Codex, thread `01a083c0-4a23-7643-a8fa-d1ec70219460`), and
the red-team pass (13 mutations, 11 killed).

Verdicts are binding. A rejected finding carries its reasoning here and is
mirrored in the PR description.

---

## Red team — P0

### RT-P0 · `.claude/reference/arch-review-log.md:47` — "production has `MFA_ENFORCEMENT_ENABLED=true`"

**Finding.** The branch's review-log entry claims #1182 flipped the flag on
production. `.claude/reference/env-vars.md:653`, the log's own #1182 entry, and
commit `cca34475` all say staging only — and ADR 0025's Consequences make the
production flip a hard prerequisite for this fold.

**Verdict: REJECTED — the claim is true; the cited sources are stale.**

Evidence, gathered live rather than from a document:

```
$ vercel env ls production   # rep-worth, team_8Xsnodz…
  MFA_ENFORCEMENT_ENABLED   Encrypted   Production   3h ago
$ vercel env ls staging
  MFA_ENFORCEMENT_ENABLED   true        staging      101d ago
```

The Production row exists and was created ~3h before this review — consistent
with #1182's resolution comment (2026-09-08T23:35Z), which records the owner
running the flip directly from a production-scoped shell AFTER PR #1216 merged:
"`MFA_ENFORCEMENT_ENABLED=true` created on the Production scope and `main`
`6e14c8a2` redeployed (`dpl_AM4wqn6EZ8fEo42WwXKJLekV2uwL`, READY) … Owner signed
in with password + TOTP and `/admin/overview` rendered — the flip is proven end
to end on production."

Every source the finding cites predates that comment. The in-repo docs are stale,
not the claim. **Stated limit:** the Production value is stored Encrypted, so the
listing proves the variable's PRESENCE and creation time, not the literal string;
the value is attested by the owner's end-to-end sign-in on the ticket. Pulling the
production env to disk to read a boolean was rejected as a worse trade.

**Actions taken.** The branch's own entry now cites the ticket and the live check
rather than leaning on the stale files. The #1182 entry and `env-vars.md:653` are
NOT rewritten — historical entries are not edited when a fact moves, and
`env-vars.md` is outside this branch's surface. Follow-up **FU-1** below.

This is exactly the failure mode CLAUDE.md names for migrations — "never
re-derive lockstep from this sentence, introspect both databases". The same rule
applies to a flag.

---

## Adversarial approach — both accepted

### ADV-1 · P1 · handler discovery is not exhaustive (`admin-aal2-audit.ts`)

`export * from './handlers'` and `export const { GET } = handlers` are both
routable and both invisible to the export index, so an ungated GET can ship while
the audit reports clean — and a compliant sibling POST does not save it.

**Verdict: ACCEPT.** Fail closed on unsupported export forms before the handler
filter, with fixtures for each form alone and beside a gated handler.

### ADV-2 · P1 · file discovery enforces a convention Next.js does not require

The collector matches the literal filename `route.ts`. Next routes
`route.{js,jsx,ts,tsx}` and this repo sets no `pageExtensions` override
(verified in `next.config.mjs`), so an ungated `route.js` is invisible AND
produces no traversal error, slipping past the new coverage floor too.

**Verdict: ACCEPT.** Collect every routable extension for routes and pages, and
make the P2 sibling lookup try them.

### ADV — answers accepted without change

- **Coverage floor**: keep it. A CI failure carrying an environmental diagnostic
  is the right outcome; converting partial traversal into a successful security
  result is not.
- **No additional lockout** among admin GET callers or `scripts/`.
- **Six page flips are correct** across all 21 pages — none missing, none extra.

---

## Red team — P1

### RT-P1a · the anti-vacuity floor has no covering test

Neutering `assertAuditCoverage` left all 91 audit tests green (mutation C2).
Standards raised the same thing: `process.exit(1)` inside a non-exported helper
is untestable by construction.

**Verdict: ACCEPT.** Make the decision pure and exported — return the fatal
messages, let `main()` print and exit — and test all three conditions plus the
healthy case, asserting message content.

### RT-P1b · the shim's bearer guarantee is not enforced where it is claimed

Hardcoding `transport` in the shim left every route-level "bearer ok" case
passing (mutation A4): those cases assert the REQUEST carried the header, not the
transport the shim RESOLVED. The guarantee is real — `admin-gate-mocks.test.ts`
kills the mutation — but the shim's header overstated where it is enforced.

**Verdict: ACCEPT.** Two fixes: each of the nine bearer cases now asserts the
resolved identity's `transport` (and the cookie case asserts `'cookie'`), so the
mutation dies in all of them; and the shim's header no longer claims more than it
delivers, naming the three suites that prove the real seam without it.

---

## Red team — P2

| id | finding | verdict |
|---|---|---|
| RT-P2a | The sidebar's 60 s `nav-counts` poll 403s forever for an aal1 admin on the two pages that stay plain, including `/admin/security` | **ACCEPT as risk** → merged into FU-2 |
| RT-P2b | `docs/runbooks/evidence/2026-09-01-phase-h-beta-launch-evidence.md:157` cites `overview/route.ts:14-15`; the fold moved it to `:19-20` | **ACCEPT** → FU-3 (outside surface) |
| RT-P2c | The anti-vacuity pin is a text scan; `vi.doMock` or a computed specifier evades it | **ACCEPT, partial.** `vi.doMock` is now refused; the residual limit stays recorded rather than overclaimed |
| RT-P2d | "27 consumers" is wrong; the tree has 30 | **ACCEPT** — corrected |

---

## Spec & correctness

### SPEC-M · MEDIUM · an unenrolled admin now lands on a dead end

Verified independently before triage:

- `src/proxy.ts` uses the LENIENT AAL form, so an admin with NO enrolled factor
  passes it (`nextLevel` is `aal1`).
- `/admin/overview` is the post-login landing page, and this branch gave it the
  STRICT `aal2: true` page gate, which redirects that admin to `/mfa/challenge`.
- `src/app/mfa/challenge/MfaChallengeForm.tsx` links only to `/login` and a
  support `mailto:` — no enrolment link, no `/admin/security`.
- `/admin/security` is reachable only from the sidebar
  (`src/components/admin/nav-config.ts:40`), which is behind the page they cannot
  render.

**Verdict: ACCEPTED RISK, owner's call (a P1-class operational finding on a
RISK = high branch).** Not fixed here, for three reasons: the fix belongs in
`MfaChallengeForm.tsx`, outside this branch's already thrice-amended surface; no
admin is affected today (production has one admin, enrolled with verified TOTP;
staging's two are enrolled — #1182); and the dead end is partly pre-existing —
eight admin pages already gated `aal2` before this branch, so an unenrolled admin
visiting `/admin/flagged` met the same wall.

What this branch genuinely changes, and why it still deserves a ticket: the dead
end moves from *a page you might visit* to *the page you always land on*, which
removes the last in-product route to `/admin/security`. It bites the first
NEWLY-minted admin under enforcement — the #1178 flow, and #1179 at go-live.
Recovery today is to type `/admin/security` directly. → **FU-2**.

### SPEC-L · LOW · the RECORDED LIMITATION list undercounts

The audit header says "All five" pages have no P2 anchor; `/admin/solicitation`
is a sixth (its page is `aal2: true`, and `src/app/api/admin/solicitation/route.ts`
does not exist). **Verdict: ACCEPT** — corrected in the header.

---

## Standards & maintainability

| id | finding | verdict |
|---|---|---|
| STD-M | `businesses/[id]/channels/route.ts` justifies its gate-first reorder with a case that cannot occur — `asLocationId` is a zero-cost cast that cannot throw (`src/lib/shared/ids.ts:53-56`, read and confirmed) — and leaves `businesses/[id]/route.ts` on the opposite ordering unexplained | **ACCEPT.** The false sentence is replaced with the true convention, and `businesses/[id]` GET is made consistent (safe: the cast cannot fail, so no response changes) |
| STD-1 | The shim is typed as bare `Mock` returning an untyped literal — no compile-time conformance to `VerifiedIdentity` | **ACCEPT** — the resolver is now typed `Promise<VerifiedIdentity \| null>` |
| STD-2 | `HANDLER_VERBS` is exported with zero consumers; `ci:fallow` flags exactly this (#1183 withheld `IdentityTransportError` for the same reason) | **ACCEPT** — un-exported, with the note that #1190 exports it when it has a consumer |
| STD-3 | `assertAuditCoverage` is untestable | **ACCEPT** — same fix as RT-P1a |
| STD-4 | The `errors?` sink's OPTIONALITY is unearned; both production callers always pass one | **REJECTED.** The optionality is the mechanism, not an accident: it is what keeps `collectRouteFiles`'s pinned quiet-return test passing byte-for-byte, which the plan-skeptic round required precisely so this branch did not silently reverse a recorded design decision while hardening its caller. Making the sink mandatory would rewrite that test to assert the new behaviour, losing the pin on the old one |
| STD-5 | Nine near-identical WHY comments restate one fact | **ACCEPT** — cut to at most one route-specific line; five dropped entirely |
| STD-6 | The anti-vacuity pin asserts less than its header claims | **ACCEPT** — same fix as RT-P2c |
| STD-7 | Ten suites still paste an identical 14-line `@/lib/db/auth` mock with `AuthError` re-declared | **ACCEPT** — `adminAuthModuleMock()` added to the shim and adopted |
| STD-8 | `routeGetRequiresAal2` is near-tautological under the widening, and the composed-pass test must hold a fixture in a CI-illegal state to exercise P2 | **REJECTED.** It is not a tautology: it credits a gate CALL and deliberately not a `resolveAdminActor` binding, which is what keeps the P2 anchor from widening onto a mutation-route shape no admin GET uses. The "CI-illegal fixture" is a synthetic temp-tree file that exists to drive P2's plain-anchor branch; requiring audit fixtures to be states the audit permits would make the failing half of every contract untestable |

---

## Follow-ups to cut (outside this branch's surface)

- **FU-1** — `.claude/reference/env-vars.md:653` still records
  `MFA_ENFORCEMENT_ENABLED` as staging-only. Production has carried it since
  2026-09-08 (#1182, owner-run). One line, one owner, stale by three hours at the
  time of writing and stale for every reader after.
- **FU-2** — An unenrolled admin under enforcement has no in-product route to
  `/admin/security`: the landing page redirects to `/mfa/challenge`, which offers
  only "back to login" and support. Smallest fix: an enrolment link on the
  challenge page when the session has no factor. Also covers RT-P2a, the sidebar's
  `nav-counts` poll 403ing on the pages that stay plain. Bites the first admin
  minted by #1178 and #1179's go-live account.
- **FU-3** — `docs/runbooks/evidence/2026-09-01-phase-h-beta-launch-evidence.md:157`
  cites `overview/route.ts:14-15`; the fold moved that refusal to `:19-20`.
