# Branch review — standards & maintainability

**Branch:** `feat-645-manual-suppression-paths`
**Diff:** `git diff 361dd074 HEAD`
**Axis:** repo standards, deep-module discipline, Fowler smells, glossary conformance. **Not** spec conformance, **not** choice of approach.
**Method:** `thermo-nuclear-code-quality-review` skill, plus `repworth-brand-design` for the JSX.

---

## 1. Verdict

**Approve with changes.** No architecture-invariant violation. No `any`, no `crypto-js`, no new
`NEXT_PUBLIC_*`, no glossary violation, no client-side access to a server-owned table, no
composition-root leak. The domain module (`suppressions-service.ts`) is genuinely deep — three
functions, DB-injected, a closed result union per function, and the Correction path is one
data-modifying CTE that makes atomicity structural rather than conventional (P-9). Migration 098
is unusually well-argued. The three new files each earn their existence.

What holds the branch back is **duplication, not design**: ~1,900 production lines added with
almost nothing deleted, and a material fraction of that is a second copy of a structure that
already existed in the same file, the same directory, or the same stylesheet. Three of the seven
findings below are the same failure repeated at three altitudes (a route preamble, a React
row-action flow, a badge wash). Fixing all three is net-negative on line count and requires no
behaviour change.

One efficiency finding (§2.1) is a genuine structural mistake rather than a micro-optimisation:
a bounded page performs an unbounded number of ledger lookups.

---

## 2. Findings

### 2.1 — MEDIUM · The suppression LATERAL is on the wrong side of the aggregate

`src/lib/solicitation/contacts-repo.ts:83`

```sql
FROM solicitation_contacts c
JOIN solicitation_visits v ON v.contact_id = c.id AND v.business_id = ${businessId}
JOIN businesses b ON b.id = c.business_id
LEFT JOIN LATERAL ( ${suppressionMatchSql(sql, sql`c.email`, accountId, 'email')} ) suppression ON TRUE
WHERE ...
GROUP BY c.id, suppression.scope
ORDER BY MAX(v.visit_date) DESC, c.id
LIMIT ${limit} OFFSET ${offset}
```

The lateral is part of the join tree, so it is evaluated **before** `GROUP BY` and **before**
`LIMIT`. Its execution count is therefore the row count of `c ⋈ v ⋈ b` — the total number of
visits for the business — not the ≤100 rows the endpoint actually returns. A location with 8,000
contacts averaging 5 visits issues ~40,000 parameterised probes against
`solicitation_suppressions` to render 50 rows.

`GROUP BY c.id, suppression.scope` is the tell: `suppression.scope` is in the grouping key only
because the planner cannot see that the lateral is functionally dependent on `c.id`. That is a
structural signal that the lookup is at the wrong altitude.

The correct shape applies the lateral to the already-paginated result, which bounds the probe
count at `limit`:

```sql
SELECT p.*, suppression.scope AS suppression_scope
FROM (
  SELECT c.id, c.name, c.email, c.phone,
         MAX(v.visit_date)::text AS last_visit_date,
         COUNT(v.id)::int AS visit_count
  FROM solicitation_contacts c
  JOIN solicitation_visits v ON ...
  JOIN businesses b ON ...
  WHERE ...
  GROUP BY c.id
  ORDER BY MAX(v.visit_date) DESC, c.id
  LIMIT ${limit} OFFSET ${offset}
) p
LEFT JOIN LATERAL ( ${suppressionMatchSql(sql, sql`p.email`, accountId, 'email')} ) suppression ON TRUE
ORDER BY p.last_visit_date DESC, p.id
```

`suppressionMatchSql` stays the single owner of the §1.2 predicate (G7) — only the join site
moves — and the `GROUP BY` loses its planner-appeasing second column.

*Caveat, stated for fairness:* PG14+ may insert a Memoize node above the parameterised inner
side, collapsing repeated probes for the same `c.email`. That is a planner choice with a cache
budget, not a guarantee, and it does not remove the per-row node overhead. The paginated form
is correct regardless of what the planner decides.

**Standard:** skill rule 7 (avoidable orchestration complexity / non-obvious structure);
"is this logic living in the right layer?".

---

### 2.2 — MEDIUM · `ContactList.tsx` implements the delete flow a second time under a new name

`src/app/(authenticated)/dashboard/requests/contacts/ContactList.tsx:251-357`, `:585-718`

The file grew 464 → 773 lines. The bulk of the addition is a structurally identical twin of a
flow already in the file:

| Concern | Delete (pre-existing) | Suppression (added) |
|---|---|---|
| Hook | `useContactDelete` :201-234 | `useContactSuppression` :289-331 |
| Controller interface | `ContactDeletion` (6 members) :192-199 | `ContactSuppression` (8 members) :259-275 |
| Fetch wrapper | `requestContactDelete` :237-249 | `requestSuppressionChange` :341-357 |
| Confirm row | `DeleteConfirmRow` :665-718 | `SuppressionConfirmRow` :611-663 |
| Per-row state derivation | `deletion.confirmingId === contact.id` | `suppression.confirming?.contactId === contact.id`, `suppression.pendingId === contact.id`, `suppression.errorId === contact.id` |

`DeleteConfirmRow` and `SuppressionConfirmRow` are the same component: `<tr><td colSpan={6}>` →
flex banner → prompt span → primary button with a `pending ? '…' : label` ternary → cancel button
→ optional `role="alert"` span. They differ in a wash colour and four strings. The two hooks are
the same state machine: `{ confirming, pending, error } + { request, cancel, confirm }`.

**The code-judo move.** One `useRowConfirmAction({ scope, endpoint, method, onDone })` and one
`<RowConfirmBanner wash prompt actionLabel pending error onConfirm onCancel />` collapse both
flows. That deletes roughly half the net addition, and the third such control — §7.4 rendering is
already committed to the Requests surface by #629 — becomes a config object instead of a fourth
copy.

**Secondary smell in the same code (feature envy).** `ContactSuppression` exposes raw hook state
(`pendingId`, `errorId`, `confirming`) so that `ContactRow` and `SuppressionControl` can each
re-derive per-row booleans by comparing ids. That is an interface widened to leak implementation:
every consumer repeats `x.someId === contact.id`. A deeper interface returns the already-resolved
per-row view — `suppression.forContact(contact.id) → { pending, error, confirming }` — and no
caller ever sees an id comparison. The pre-existing `ContactDeletion` has the same shape, so this
PR replicated a shallow interface instead of deepening it.

**Standard:** working rules ("no near-duplicate…"); skill flags "copy-pasted logic instead of
extracted helpers", "refactors that move complexity around but don't delete it", Fowler
duplicated-code + feature-envy.

---

### 2.3 — MEDIUM · The contacts route preamble now exists in triplicate

`src/app/api/dashboard/contacts/[id]/suppression/route.ts:31-60` and `:62-92`

`mark` and `clear` are the same handler:

```ts
const owner = await requireContactsWriteAccess(sql, request);
if (!owner.ok) return owner.response;
const { user, accountId } = owner;
try {
  const scoped = await resolveContactsScopedId(sql, request, { accountId, userLocationId: user.locationId }, params);
  if (!scoped.ok) return scoped.response;
  /* ← one line differs */
} catch (error) {
  reportCaughtError(ENDPOINT, error, { accountId });
  return errorResponse('Failed to update contact', 500);
}
```

The identical block is also in `src/app/api/dashboard/contacts/[id]/route.ts:23-42`. That is
three copies of the auth + scope + catch policy for one route family.

`src/app/api/dashboard/contacts/location-scope.ts` already declares itself "Single owner of the
access/scope policy shared by the contacts routes" — it is the obvious home for a
`withScopedContact(handler: (ctx: { sql, accountId, locationId, contactId, userId }) => Promise<NextResponse>)`
wrapper. Each route body then reduces to its distinctive lines: the repo call and the result map.

Concrete maintenance failure: adding a rate limiter, changing the `uniform-not-found` exposure,
or adding a correlation id to `reportCaughtError` is a three-site edit today, and nothing fails if
one site is missed.

**Standard:** working rules ("Route handlers … orchestrate only"); invariant #12; Fowler shotgun
surgery.

---

### 2.4 — MEDIUM-LOW · The lookup puts the recipient's raw handle in a URL, against §9.5

`src/app/api/admin/suppressions/route.ts:27` · `src/app/admin/suppressions/SuppressionsClient.tsx:58`

```ts
const email = request.nextUrl.searchParams.get('email') ?? '';
```
```ts
fetch(`/api/admin/suppressions?email=${encodeURIComponent(email)}`)
```

Spec §9.5 and CLAUDE.md's logging rule both say the raw handle never reaches a log. The sibling
correction route honours this with visible care — it logs `parsed.data.suppressionId` and carries
a comment saying "the suppression row id is the correlation key, never the Normalized handle."
The lookup route then places the same handle in a request path, where Vercel access logs, the
admin's browser history, and any referrer capture it verbatim. The rule is enforced against the
app's own `console` calls but structurally defeated by the transport choice, in the same file
family, in the same PR.

The plan reproduces this GET at line 866 as code, but records no reasoning weighing it against
§9.5, so it is not a decision the review must defer to. `POST /api/admin/suppressions/lookup`
(or moving the handle to a POST body on the existing route) costs one `withSameOrigin()` wrapper
and removes the leak entirely.

**Standard:** spec §9.5 / CLAUDE.md "Never log … secrets"; the branch's own stated posture.

---

### 2.5 — MEDIUM-LOW · A 404 renders as a raw error token plus a false statement

`src/app/admin/suppressions/SuppressionsClient.tsx:114-126`, `:533-542`

`submitCorrection` throws `new Error(body.error ?? …)`. For a 404 the server sends
`{ error: 'not_found' }`, so the surface renders:

> **not_found — the suppression is still in place.**

Two defects in one line. The literal API error token `not_found` is displayed to the admin, and
the appended sentence is **false**: a 404 means the row was not found by the DELETE, i.e. it is
already gone (a concurrent correction, or a stale `correctionTarget` after the entry-triggered
refetch — the target is reset on `runLookup` and on `correction` success, but not on an `entry`
success that refetches the list underneath it).

The file's own docblock argues that "the copy in this file is load-bearing, not decoration" and
that "believing an opt-out was removed when it was not is the inverse hazard". This line commits
the mirror-image error: telling an admin a suppression stands when it does not. `not_found`
deserves its own branch — "That record no longer exists. Run the lookup again." — distinct from
the transport-failure copy.

**Standard:** skill rule 5 (boundary cleanliness — an internal error code crossing to a user
surface untranslated); the file's own stated contract.

---

### 2.6 — LOW · Two console badge variants re-implemented as inline TS style objects

`src/app/(authenticated)/dashboard/requests/contacts/ContactList.tsx:511-537`

```ts
const SUPPRESSION_BADGE_STYLE = {
  global:  { background: 'var(--rw-cream)',      color: 'var(--rw-app-text-muted)' },
  account: { background: 'var(--rw-accent-100)', color: 'var(--rw-accent-800)' },
};
```

Both already exist in `src/app/(authenticated)/_styles/console.css`, byte-for-byte:

- `.badge-edited { background: var(--rw-accent-100); color: var(--rw-accent-800); }` (:1160)
- `.escalation-badge--low { background: var(--rw-cream); color: var(--rw-app-text-muted); }` (:1173)

The Console design system keeps every badge wash as a `.badge badge-<variant>` pair in
`console.css` — `badge-pending`, `badge-posted`, `badge-awaiting`, `badge-edited`, `badge-failed`,
`badge-auto`, `persona-badge--*`, `escalation-badge--*`. A repo-wide grep finds **no** other
console badge styled inline; this is the first. A palette change to the accent badge treatment
now has two homes, and the TS one is invisible to anyone reading the stylesheet.

Fix: add `.badge-suppressed-global` / `.badge-suppressed-account` next to their siblings and drop
the TS object, keeping the (good) `Record<SuppressionDisplayState, …>` exhaustiveness by mapping
state → class name instead of state → style object.

Note also that `--rw-cream` is an Island token the Console inherits by fall-through; `tokens.css`
documents that inheritance as intentional, so reusing `.escalation-badge--low`'s existing wash is
the safer expression of the same intent than re-declaring it.

**Standard:** `repworth-brand-design` (tokens/system, never ad-hoc); skill "bespoke helper where
the codebase already has a canonical utility".

---

### 2.7 — LOW · Admin console button/field styles copied instead of promoted to the shared primitives

`src/app/admin/suppressions/SuppressionsClient.tsx:38-45`

`PRIMARY_BUTTON` is byte-for-byte identical to the inline className at
`src/app/admin/autonomy/AutonomySuspensionsClient.tsx:101`, and `FIELD` is that file's line 95
minus `min-h-20 resize-y` plus `w-full`. Both pages live in the same **Safety** nav group, and
`src/components/admin/ui/` is the console's declared home for shared primitives (it already holds
`AdminPage`, `DataTable`, `StatusBadge`, `states`, `StatTile`, `FilterBar`). The PR lands
immediately after "console Phase 2 — server-first on shared primitives" (#650) and adds the fifth
copy of the primary-button recipe without adding a primitive.

This is the cheapest of the seven to fix: `AdminButton` + `AdminField` in
`src/components/admin/ui/`, consumed here and by `AutonomySuspensionsClient`. Net-negative on
lines, and the next admin page gets them free.

**Standard:** skill "copy-pasted logic instead of extracted helpers" / "logic added in the wrong
layer when there is a clear canonical home".

---

### 2.8 — LOW · The service's internal result union is the wire contract

`src/app/api/admin/suppressions/route.ts:35` · `src/app/admin/suppressions/SuppressionsClient.tsx:57-84`

```ts
return NextResponse.json(result, { headers: NO_STORE_HEADERS });   // result: LookupSuppressionsResult
```

`LookupSuppressionsResult` is the domain module's internal discriminated union — including its
`ok: true` discriminant — and it is serialised wholesale as the public response body. The client
then hand-narrows the body back into the same type by checking `body.ok !== true` plus three
`Array.isArray`/`typeof` guards, and asserts the array *elements* without validating them.

Consequence: adding a second `ok: false` variant to the service (say `handle_too_long`) silently
changes the HTTP contract, and the client's narrowing falls through to `throw new Error(body.error)`
— the new error renders as a raw token, exactly as in §2.5. The route should map the union to a
response shape it owns (`{ handle, rows, corrections }` on 200, `{ error }` on 4xx) so the
internal union stays internal and the `ok` field stops doing double duty.

**Standard:** skill rule 5/6 (boundary cleanliness; implementation details leaking through an API);
deep-module discipline — the interface widened to expose the module's error-signalling mechanism.

---

## 3. What the branch got right (worth preserving under any refactor)

- **`correctSuppression` as one data-modifying CTE (P-9).** Atomicity is a property of the
  statement, not of caller discipline. The audit record is built from `DELETE … RETURNING`, so a
  concurrent correction cannot mint a record describing a row it did not remove. This is the
  strongest single piece of engineering in the diff, and the reasoning in the docblock is correct.
- **`recordSuppression`'s discriminated-union input.** `owner_manual + global` is untypeable at
  the call site; the DB CHECK is a backstop rather than the only defence.
- **`toSuppressionDisplay`'s output closure.** The four-key result is what forbids the leak, and
  P-8 correctly refuses to overclaim that the narrow input type prevents passing a wider object.
- **Migration 098's no-FK / no-`account_id` argument.** The retention-obligation reasoning and the
  `accountLinkedTablesFromMigrations()` consequence are both real, and the `reason ~ '[^[:space:]]'`
  CHECK (over one-arg `btrim`, which strips spaces only) is a genuinely non-obvious catch.
- **Invariant #15 throughout.** `suppressions-service.ts` and `contacts-repo.ts` take `sql`/`tx`/`db`
  as parameters; only the three route handlers and the server page import the singleton.
- **Live-DB suite conventions.** All three new integration suites are `*.integration.test.ts`, hold
  `acquireLiveDbLock`, and assert with `assertSchemaReady` rather than applying migration SQL. CI's
  `test` job runs a `postgres:16` service with `TEST_DATABASE_POOL_URL` set, so they do execute.
- **Glossary.** Zero violations. "Suppression ledger", "Suppression scope", "Normalized handle",
  "Correction path", "Consent ledger", "Unsubscribe token", "Success receipt", "Neutral page" are
  used as locked. Every occurrence of `re-subscribe` / `unsuppress` in the diff is either a
  prohibition being stated or a test asserting the term's absence from the UI
  (`SuppressionsClient.test.tsx:1376`, `route.test.ts:2278`). The tenant-scope allowlist reasons
  are written in the glossary's own vocabulary.

---

## 4. Low-confidence appendix (do not action without a second opinion)

These are below the bar for the returned findings table — stylistic, speculative, or defensible
as-is.

1. **`StatusBadge` gains no entries for the new vocabularies.**
   `SuppressionsClient.tsx:149,155,196,197` pass `row.scope` and `row.source`. Neither
   `'global'`/`'account'` nor any of the seven sources is a key in `STATUS_BADGE_STYLES`, so all
   four columns render as identical neutral-grey pills — including global-vs-account, the single
   most safety-critical distinction on the screen. The component explicitly tests the
   unknown-status → NEUTRAL fallback (`StatusBadge.test.tsx:27`), so this is supported behaviour,
   and other consumers already pass unregistered statuses. Worth raising with design, not with
   the author.

2. **`LIMIT 20` on the corrections list is silent.** `suppressions-service.ts:106` caps prior
   corrections at 20 with no `total` and no "showing 20 of N" affordance on a compliance screen.
   The cap is planned and tested ("capped at twenty"), so it is a decision; the missing truncation
   indicator is the gap. Low practical impact — 20 corrections for one handle would itself be an
   incident.

3. **`liveColumns` / `correctionColumns` are rebuilt every render** (`SuppressionsClient.tsx:145`,
   `:189`), giving `DataTable` fresh array and closure identities. Immaterial at these row counts;
   flagged only because they are pure constants but for the `onSelect`/`selectedId` capture in one
   cell renderer.

4. **`SuppressionsClient.tsx` is 547 lines with six `useState` and cross-cutting resets.** Under
   the 1,000-line threshold and legibly sectioned, but the manual-entry form is ~75 lines of JSX
   inlined in the page body while its two siblings are extracted components. Extracting
   `<ManualEntryPanel>` would make the three ritual steps symmetric.

5. **`correctionTarget` can go stale.** Reset on `runLookup` and on correction success, but not on
   a successful manual entry, which invalidates and refetches the lookup underneath the open panel.
   The failure is caught server-side as a 404 — see §2.5 for the part that is actionable.

6. **Zod issue messages reach the admin verbatim.** `route.ts:61` and `correct/route.ts:38` return
   `parsed.error.issues[0]?.message`, which the client renders in a `role="alert"`. This is the
   repo-wide pattern (16+ existing routes), and both client forms guard non-empty before enabling
   submit, so it is precedent rather than a defect.

7. **`suppressions-service.ts:194` spells `Sql | TransactionSql` inline** where
   `suppression.ts:22` already defines `type SqlExecutor = Sql | TransactionSql` — unexported, so
   this is not reuse-avoidance so much as an export the module never made.

8. **`--rw-cream` is an Island token used in a Console component** (`ContactList.tsx:516`).
   `tokens.css` documents the fall-through as intentional and `console.css:1173` already does the
   same thing, so this is correct today. Folded into §2.6 rather than raised separately.
