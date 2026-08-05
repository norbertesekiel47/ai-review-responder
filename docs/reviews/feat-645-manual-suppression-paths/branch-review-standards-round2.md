# Branch review — standards & maintainability · ROUND 2 (verification only)

**Branch:** `feat-645-manual-suppression-paths`
**Delta reviewed:** `git diff 48c11018 HEAD` — fix commits `a0674ed6`, `4c157435`, `4af0af58`, `8361ad42`, `efe15be4`
**Round 1:** `docs/reviews/feat-645-manual-suppression-paths/branch-review-standards.md`
**Scope discipline:** this is a verification pass. I did **not** open new fronts against unchanged
code. Everything below traces to one of my eight round-1 findings, to a fix for one of them, or to
the D-A11 schema change I was explicitly asked to judge. The "Appendix: new, untriaged" section is
therefore **empty**, and nothing in this report outside §1–§4 affects the conclusion.

---

## 1. Verdict

**Approve.** Seven of eight findings are addressed; one (§2.2) is addressed at its headline and
leaves its explicitly-labelled secondary sub-point untouched. The rejection of §2.7 is correct —
and rests on a stronger constraint than the one the triage cited. The D-A11 schema change is
maintainable on my axis and its supporting inventory work is unusually thorough.

The fixes introduced **one new low-severity defect** (a single-caller constant in the tenant-scope
allowlist whose comment names a second caller that does not exist) and **three small residuals**
(one stale `docs/directory.md` row, one unregistered new file, one boundary map typed more loosely
than its sibling in the same PR). None blocks the merge.

Notably, the two riskiest fixes are the two best executed. The §2.1 SQL refactor is correct against
a live PG16 at migrations head, and the §2.2 React refactor passes the component tests written
against the *old* structure without those tests being edited — which is the strongest available
evidence that no behaviour moved.

### Verification actually run (not inferred)

| Check | Result |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `ci:static-policy` · `ci:tenant-scope` · `ci:rls-audit` · `ci:db-imports` · `ci:live-db-suites` · `ci:outbox-seam` · `ci:outbox-status` | all PASS |
| Unit + component (contacts, admin suppressions, contacts API, offboarding, repo-wide `src/__tests__`) | 47 files, **1238 tests PASS** |
| Live-DB integration (`owner-do-not-contact`, `contacts-repo`, `suppressions-correction`, `migration-098`) against local PG16 at head | 4 files, **36 tests PASS** |
| `solicitation_suppression_corrections` column count on the provisioned test DB | 13 — i.e. 098 **as edited** (D-A11) is applied |

---

## 2. Finding-by-finding verification

### §2.1 — Suppression LATERAL on the wrong side of the aggregate → **ADDRESSED**

`src/lib/solicitation/contacts-repo.ts:63-88`, `:93-154`

The lateral is out of the page query's join tree. The page query is back to `GROUP BY c.id` — the
planner-appeasing `suppression.scope` grouping column, which was the structural tell, is gone. The
probe moved into `readPageSuppressionScopes`, which drives the lateral from
`unnest(${distinct}::text[])` — one probe per **distinct handle on the page**, so the execution
count is bounded by `limit` (≤100) instead of by `c ⋈ v` for the whole business.

The three correctness risks the second round trip could have introduced, checked individually:

- **A handle appearing twice.** `Array.from(new Set(...))` dedupes before the query, and the map is
  keyed by handle so a repeat could not double-count anyway. Belt and braces: the live schema
  carries `solicitation_contacts_email_uniq UNIQUE (business_id, email) WHERE email IS NOT NULL`, so
  two contacts in one business cannot share a handle in the first place. The dedup is defensive, not
  load-bearing — which is the right way round.
- **A contact with a NULL email.** Filtered twice, deliberately: `handle !== null` before the query
  (so `unnest` never receives a NULL), and `row.email === null ? null : …` at map time (so a
  phone-only contact resolves to `suppression: null` without a lookup). The comment states the
  domain reason — "a phone-only contact has no email handle and matches no row by definition".
- **Cross-account isolation.** `accountId` is still the fragment's parameter, so the `scope='global'
  OR (scope='account' AND account_id = $n)` arm is unchanged. Proven, not assumed:
  `owner-do-not-contact.integration.test.ts:582` — *"listContacts ignores an account suppression
  owned by another account for the same handle"* — passes against the real DB, as does the
  global-wins case at `:319` and the four-key output-shape case at `:607`.

`suppressionMatchSql` is **composed, not re-spelled** (`contacts-repo.ts:80`), so G7's single owner
of the §1.2 predicate holds. `ci:tenant-scope` is green, which is a second-order confirmation: that
audit keys on `file + table + normalized SQL`, and a re-spelled predicate would have produced a
missing-entry failure exactly as it did in D-A5.

**Accepted tradeoff, stated for the record (not a defect).** `listContacts` is now three round trips
(page ∥ count, then the probe), and the suppression state is read in a *second snapshot* from the
page. A row marked or cleared between the two reads renders one refresh behind. This is a
display-only surface — the dispatch gate is the authority on whether mail goes out — so the exposure
is a stale badge, never a stale send. The code names the ordering as deliberate
(`// Ordered after the page, not beside it: the probe's input IS the page.`), which is the right
altitude for the comment.

**Residual (LOW).** `docs/directory.md:573` still describes the §7.4 state on `listContacts` as
"a `LEFT JOIN LATERAL` over `suppressionMatchSql`". That is now the *second query's* shape, not the
page query's, and the sentence reads as though the probe still sits in the page's join tree — which
is precisely the thing this fix removed. `efe15be4` resynced four other directory rows and
CONTEXT.md; this one was missed.

---

### §2.2 — `ContactList.tsx` implements the delete flow a second time → **PARTIALLY ADDRESSED**

`src/app/(authenticated)/dashboard/requests/contacts/ContactList.tsx`

**The headline duplication is genuinely gone.** `useContactDelete`, `useContactSuppression`,
`ContactDeletion`, `ContactSuppression`, `DeleteConfirmRow` and `SuppressionConfirmRow` are all
deleted, replaced by one `useRowConfirmAction<TAction>` (`:253`) and one `RowConfirmBanner`
(`:649`). Both flows are now instances of one machine parameterised by a `send` function, and the
third such control (§7.4 rendering on the Requests surface, #629) becomes a config object rather
than a fourth copy — which was the point of the finding.

The refactor also fixed a latent fragility I did not raise: `colSpan={6}` became
`colSpan={TABLE_HEADERS.length}`.

**All three preservation requirements hold, and all three are behaviour-tested:**

| Requirement | Where | Test |
|---|---|---|
| Marking and clearing keep DIFFERENT confirm copy (§7.6) | `SUPPRESSION_CONFIRM_COPY` `:595` — mark names what *stops*, clear names what *resumes* | `contacts-ui.test.tsx:348` asserts the clear prompt renders **and** the mark prompt does not |
| Delete keeps the danger wash, suppression the accent wash | `ROW_CONFIRM_TONE` `:619`, with `tone` an explicit per-call-site choice (`:481` accent, `:494` danger) rather than inferred from the row | — |
| A global row renders **no control at all**, not a disabled one | `SuppressionControl` `:567` — `if (!contact.suppression.clearableByOwner) return null` | `contacts-ui.test.tsx:242` asserts no `/allow\|undo\|clear/i` button and no `/don't contact/i` button exist |

The decisive evidence is that `contacts-ui.test.tsx` is **unchanged in this delta**. Nine
suppression/delete behaviour tests written against the old two-hook structure pass against the new
one-hook structure without edits. A refactor that had flattened a distinction would have had to
touch them.

I also checked that the URL builders stayed apart — `requestContactDelete` (`:310`) and
`requestSuppressionChange` (`:331`) remain two functions that never meet, with a docblock explaining
that this is the one thing the shared machine deliberately does *not* absorb. That is the correct
seam: share the interaction, split the endpoint.

**What was NOT addressed** — the finding's explicitly-labelled *"Secondary smell in the same code
(feature envy)"*. `RowConfirmController` still exposes raw hook state (`open`, `pendingId`,
`errorId`), and consumers still re-derive per-row booleans by comparing ids in **seven** places:
`:422`, `:424`, `:427`, `:486`, `:498`, `:499`, `:551`. There is no `forContact(contactId) → {
pending, error, confirming }` seam. The shallow interface was unified rather than deepened, so the
`x.someId === contact.id` idiom now has one owner instead of two — an improvement in blast radius,
but the interface still leaks its implementation to every consumer.

Net line change is **773 → 769 (−4)**, not the "roughly half the net addition" the finding
projected. That gap is honest rather than suspicious: the two flows were unified in place, and the
replacement carries substantially more explanatory prose (the `RowConfirmBanner`, `ROW_CONFIRM_TONE`
and `SUPPRESSION_CONFIRM_COPY` docblocks each argue a safety property). I do not count load-bearing
comments against a line budget.

---

### §2.3 — Route preamble in triplicate → **ADDRESSED**

`src/app/api/dashboard/contacts/location-scope.ts:116-149`

`withScopedContact(sql, { endpoint, failureMessage }, handler)` lands in the module that already
declared itself the single owner of this policy. Three consumers: `[id]/route.ts` DELETE,
`[id]/suppression/route.ts` POST and DELETE. Each route body is now its repo call plus its result
map — the two things that legitimately differ — and `endpoint`/`failureMessage` are the only
per-route parameters, which is exactly the axis of variation the finding identified.

**All four preservation requirements verified:**

1. **Flag gate before auth.** `withScopedContact:125` calls `requireContactsWriteAccess` first, and
   that function (`:50-58`) returns the 404 from `solicitationWatchEnabled()` *before* reaching
   `requireWritableOwner`. Invariant #13 holds: watch-mode-off leaks no auth-shaped response.
   Independently covered by the shared `flag-404.test.ts` table (D-A7), which asserts
   `mockRequireWritableOwner` was never called.
2. **Uniform 404 for a foreign contact.** Unchanged and now single-sited: malformed UUID → 404 in
   `resolveContactsScopedId:76`; foreign/archived location → `resolveDashboardLocation(…, exposure:
   'uniform-not-found')`; foreign contact → the repo's `not_found`, mapped to `errorResponse('Not
   found', 404)` in each handler. A caller still cannot distinguish "not yours" from "does not
   exist".
3. **`withSameOrigin()` outermost.** All three exports are `withSameOrigin()(withScopedContact(…))`.
   The wrapper's docblock explains why it is deliberately *not* folded inside — a cross-origin
   request must be refused before the preamble runs at all.
4. **Auth outside the catch.** `:125-127` precede the `try` at `:129`, preserving
   `requireWritableOwner`'s rethrow contract instead of flattening an auth-infrastructure failure to
   a 500 carrying this route's copy. The docblock states this as point 2, which is the right place
   for it — the next person to add a `try` here will read it.

The concrete maintenance failure the finding named is now discharged: adding a rate limiter or a
correlation id is a one-site edit.

---

### §2.4 — Raw handle in a GET query string (§9.5) → **ADDRESSED**

`src/app/api/admin/suppressions/lookup/route.ts` (new) · `src/app/api/admin/suppressions/route.ts`

The GET is **deleted**, not deprecated. The lookup is `POST /api/admin/suppressions/lookup` with
the address in a JSON body, behind `requireAdminWithAal2` and wrapped in `withSameOrigin()` (a POST
is now a mutation-shaped request, so CSRF protection is required and present). The client POSTs
(`SuppressionsClient.tsx:92-98`).

The route header carries an explicit *do not undo this* instruction naming the mechanism — access
logs, log drains, browser history — which is the durable form of the fix. Tested at two levels:
`route.test.ts` — *"carries the looked-up address in the request body and never in the URL"* and
*"enforces same-origin on the admin suppression lookup"*; `SuppressionsClient.test.tsx` — *"sends
the looked-up address in the request body and never in the URL"*.

`docs/directory.md` gained the `suppressions/lookup/route.ts` row and the existing
`suppressions/route.ts` row was rewritten to drop the GET. The §9.5 reasoning is recorded in both.

---

### §2.5 — 404 renders a raw error token plus a false statement → **ADDRESSED**

`src/app/admin/suppressions/SuppressionsClient.tsx:35-66`, `:145-172`, `:575-593`

Both halves of the defect are fixed, and fixed at the right altitude:

- **The false claim.** `submitCorrection` now *returns* `'already_removed'` for a 404 instead of
  throwing (`:166`), so the concurrent-correction case can no longer inherit the genuine-failure
  branch's "— the suppression is still in place." It renders its own amber `role="alert"` with
  truthful copy (`:584`), and `onSuccess` invalidates the lookup query so the admin ends up looking
  at current ledger state rather than the row they just acted on. The comment on the amber branch
  gets the semantics exactly right: not green (nothing this admin did took effect), not red (no
  failure occurred).
- **The raw token.** `ERROR_COPY` + `errorSentence` (`:54-66`) guarantee that `body.error` is never
  rendered directly on any of the three endpoints. The clause-shaped, no-trailing-period convention
  is documented so the Correction path can compose onto it.

The `CorrectionOutcome = 'corrected' | 'already_removed'` union is the right shape — it makes the
distinction the finding was about into a type rather than a comment.

**Residual (LOW).** `ERROR_COPY` is typed `Record<string, string>` — open-keyed, so nothing catches
a dead entry or a missing one. Two live codes are absent: `unauthorized` (401, `route-helpers.ts:89`)
and `mfa_check_failed` (403, `admin-mfa-gate.ts:29`). Both fall through to a safe sentence, so the
finding's actual defect is closed and the failure mode is degraded specificity, not a leaked token.
The inconsistency is what I'd flag: the *same PR* deliberately typed `LOOKUP_ERROR_STATUS` as an
exhaustive `Record<LookupFailure['error'], number>` — with a docblock arguing that an incomplete
record failing typecheck "is the point" — and then typed the sibling map open. Same author, same
boundary, two standards.

---

### §2.6 — Badge washes as inline TS style objects → **ADDRESSED** (different implementation, argued)

`ContactList.tsx:511-534` · `src/app/(authenticated)/dashboard/requests/contacts/contacts.css` (new)

`SUPPRESSION_BADGE_STYLE: Record<…, React.CSSProperties>` became `SUPPRESSION_BADGE_CLASS: Record<…,
string>` mapping state → `.badge suppression-badge suppression-badge--{global,account}`, with the
washes in a route-colocated stylesheet. The exhaustiveness the finding asked to keep is kept — it is
still keyed on the display seam's closed scope enum. No console badge is styled inline any more.

The fix **declined** my suggested implementation (add `.badge-suppressed-*` to `console.css`, or
reuse `.escalation-badge--low`) and says why, in the stylesheet header: those two classes mean "a
reply was edited" and "escalation severity: low", so reusing them would let a future restyle of an
unrelated surface silently restyle an opt-out badge. **That is a better argument than the one I
made**, and I accept it. The residual duplication is two CSS declarations, both spelled in tokens,
so a *palette* change still has one home (`tokens.css`) — only a change to which token pair a badge
uses would need two edits, and the header argues that such a change *should not* propagate.

The colocation matches the sibling precedent: `dashboard/requests/requests.css` is imported the same
way by three components in the same tree.

**Residual (LOW).** `contacts.css` is a new file and is **not** registered in `docs/directory.md`,
while its sibling `requests.css` is (line 117). The working rule is "Default is 'no new file' —
check `docs/directory.md` first", and the same commit series added four other directory rows, so
this is an omission rather than a position.

---

### §2.7 — `PRIMARY_BUTTON` is a fifth copy of the admin primary-button recipe → **REJECTION STANDS**

`SuppressionsClient.tsx:72`, `:76` are unchanged, as expected.

**I do not think the reasoning is wrong, and I am not re-raising it.** I'd record that the binding
constraint is stronger than the one the triage cited:

- `src/components/admin/ui/**` is **not in this branch's `allowed_edit_surface`** (the intake lists
  only `src/components/admin/nav-config.ts` and `src/components/admin/__tests__/**`). Adding
  `AdminButton`/`AdminField` there is surface amendment #3.
- D-A11 records the amendment budget at **2 of 2**, with "a third means teardown".

So the blocker is the `/feature` process, not merely concurrency — D-A2 only claims
`src/components/admin/ui/DataTable.tsx` for the other worktree, which would not by itself have
prevented adding two new files beside it. Both arguments reach the same answer; the process one is
the load-bearing half, and it is the one worth writing down for whoever picks the follow-up up.

**One process note.** I could not find the follow-up recorded anywhere durable — no entry in
`docs/superpowers/plans/feat-645-manual-suppression-paths-deviations.md`, no issue reference, no
mention in `docs/` or `.claude/` outside my own round-1 report (`rg -il 'AdminButton|AdminField'`
returns that file and nothing else). A follow-up that lives only in a review artifact is a follow-up
that will not happen. The fifth copy is cheap to carry; the sixth will be cheaper still to add.

---

### §2.8 — Service result union serialised as the wire contract → **ADDRESSED**

`src/app/api/admin/suppressions/lookup/route.ts:36-47`, `:83-86`

The route now owns its response body: `{ handle, rows, corrections }` on 200, `{ error }` on 4xx.
The service's `ok` discriminant stays internal. The mechanism is better than "map it at the
boundary" — `LOOKUP_ERROR_STATUS: Record<LookupFailure['error'], number>` is derived from
`Extract<LookupSuppressionsResult, { ok: false }>`, so adding an `ok: false` variant to the service
makes the record incomplete and **fails typecheck**, forcing the new failure mode to choose a status
at the boundary rather than reaching the client as a raw token inside a 200. That closes the exact
compound failure §2.8 and §2.5 shared.

The client dropped its `body.ok !== true` narrowing accordingly. Tested: *"maps the lookup service
result to an explicit response body rather than serialising the union"* and *"rejects a malformed or
unknown-field lookup body before reading any tenant"*.

Minor and not worth acting on: `lookupAddress` still declares its return as
`LookupSuppressionsResult` and re-wraps `{ ok: true, … }` locally. That is a shared *type* for a
local shape, not a shared wire contract, so the hazard the finding named is closed.

---

## 3. D-A11 — migration 098 gains three columns, table joins `TENANT_TABLES` + `TABLE_DISPOSITIONS`

Judged on standards & maintainability only, as instructed. **Sound.**

**Naming.** The three columns are `account_id`, `created_by_user_id`, `note` — the same spelling as
the source table's columns, which is what makes "copied from the removed row" legible without a
lookup. The migration comment explicitly names and refuses the `original_*` alternative, and states
why: those names slip past `accountLinkedTablesFromMigrations()` on a word-boundary technicality,
and "naming data to dodge a governance check is worse than the gap it hides." Recording the
*rejected* option beside the chosen one is the difference between a decision and an accident, and it
is placed where the next person to widen this table will hit it.

**Cohesion.** Strictly improved. The table previously held half of the assertion it corrects (what
was removed) and not the other half (that the original entry was legitimate). It now holds the
whole record. The three nullability decisions are each justified in one clause — machine sources
write no author and no note; a `global` row may name no account — and the log's shape section was
updated from "Every column is `NOT NULL`" to "Exactly three columns are nullable … and each for a
stated reason", so the doc and the DDL agree.

**The `TABLE_DISPOSITIONS` entry** (`table-disposition.ts:402-408`) is byte-consistent with its two
family siblings: `retain_compliance_limited_pii` / `compliance_handle_hash` /
`allowed_limited_retention`, the same triple `solicitation_suppressions` and
`solicitation_unsubscribe_tokens` already carry. The inventory reads as one system rather than as a
table with a bespoke classification. `compliance_handle_hash` is now marginally under-descriptive —
the table has a real `account_id` — but `solicitation_suppressions` has one too and carries the same
label, and the purge arm deliberately does *not* scope through that column, so the label continues
to mean the right thing ("the tenant link is not the verification key").

**The purge-verification arm** (`purge-verification.ts:665-687`) is the most interesting code in the
change and it is written to be read. It is an *inverted* check — every sibling arm counts rows that
survived when they should not have; this one counts a row that survived **having lost the evidence
it exists to hold**. The comment says that outright, and then answers the question a reader will
actually have: why scope through `users` rather than through the table's own `account_id`? Because
that column is the thing under suspicion, and a scrub that nulled it would make the row invisible to
a predicate that reads it. That reasoning is not recoverable from the SQL and would have been lost
without the comment.

One thing left implicit: the arm's completeness depends on `created_by_user_id` being non-null for
every `scope='account'` row — guaranteed by 096's scope/source pairing CHECK plus the
`RecordSuppressionInput` discriminated union, neither of which is cited here. If that pairing ever
loosens, this arm silently narrows. Worth one clause if anyone edits it; not worth a change now.

**Supporting work worth calling out.** `schema-ready.ts:326-343` now asserts the three new columns
explicitly, with a docblock explaining that "the last object exists" proves the migration ran *once*,
not that it ran *in its current form* — because 098 was edited in place while LOCAL-ONLY. That
converts a container provisioned before the edit from an undefined-column crash at
`correctSuppression` into the actionable `pnpm test:db:setup` message. Catching the second-order
consequence of an in-place migration edit, in the test-infrastructure layer, is the kind of thing
that usually gets found by the next person at 2am instead.

The `docs/security/rls-inventory.md` row and the `.claude/reference/migrations-log.md` rewrite are
both complete and both carry the reasoning rather than just the fact.

---

## 4. Did any fix introduce a new defect?

**One, LOW.**

### `ADMIN_SUPPRESSION_CORRECTION_SQL` is a single-caller constant whose comment names two callers

`scripts/ci/tenant-scope-allowlist.ts:180-187`

The hoisted constant's comment reads:

> `// … so the audit attributes it to solicitation_suppressions AND`
> `// solicitation_suppression_corrections — hoisted once rather than copy-pasted into both entries.`

It has exactly **one** consumer (`:3200`, the `solicitation_suppressions` entry). The
`solicitation_suppression_corrections` entry at `:3192` uses the *lookup* SELECT, not this CTE. So
the constant is a single-caller abstraction, and its justification describes a second call site that
does not exist.

This is documentation drift, not a broken audit: `ci:tenant-scope` is green, and that audit fails on
**unused** entries as well as missing ones (it did exactly that in D-A5), so no entry is absent
today. The cost is a reader following the comment to look for a second entry and not finding one,
then having to work out whether the audit is under-detecting or the comment is wrong.

Cheapest fix is to correct the comment to say the CTE is spelled once because it is long and
error-prone to re-key, and drop the claim about two entries.

### Explicitly checked and clean

- **New near-duplicates:** none, beyond the two argued CSS declarations in §2.6. The fixes deleted
  six duplicated constructs (two hooks, two interfaces, two confirm rows) and added four shared ones
  (`useRowConfirmAction`, `RowConfirmBanner`, `withScopedContact`, `mutationErrorCopy`), each with
  ≥2 consumers.
- **New inline styles:** none. `ROW_CONFIRM_TONE`'s `#FDFBF7` hex is not new — it is the
  pre-existing `DeleteConfirmRow` literal, moved verbatim. §2.6 removed inline styles on net.
- **New single-caller abstractions:** `readPageSuppressionScopes` (a private module-local extraction
  for readability — fine), `LOOKUP_ERROR_STATUS` (one entry today, but its whole purpose is
  compile-time exhaustiveness at a boundary — fine), and the tenant-scope constant above (the one
  finding).
- **Invariant regressions:** none. `ci:db-imports` green (invariant #15 — `withScopedContact` takes
  `sql` as a parameter; only the route files import the singleton). `ci:static-policy` green (no new
  `NEXT_PUBLIC_*`, no `crypto-js`). `ci:rls-audit` green with the new table inventoried.
  `ci:live-db-suites` green.
- **Behaviour drift in the §2.2 refactor:** none. `ContactRow`'s conditionals, `aria-label`s, error
  placement and both banner call sites were diffed line-for-line against `48c11018` and are
  structurally identical.

---

## 5. Residuals worth one commit (none blocking)

| # | Where | What |
|---|---|---|
| R1 | `scripts/ci/tenant-scope-allowlist.ts:180-187` | Comment claims two consumers; there is one. |
| R2 | `docs/directory.md:573` | `contacts-repo.ts` row still describes the §7.4 lateral as living in `listContacts`' page query. |
| R3 | `docs/directory.md` (~line 117 area) | New `dashboard/requests/contacts/contacts.css` is unregistered; sibling `requests.css` is registered. |
| R4 | `SuppressionsClient.tsx:54-61` | `ERROR_COPY` is `Record<string, string>`; `unauthorized` and `mfa_check_failed` are missing (fail-safe). Consider keying it exhaustively, as `LOOKUP_ERROR_STATUS` is in the same PR. |
| R5 | `ContactList.tsx` (7 sites) | §2.2's secondary feature-envy sub-point: `forContact(id)` seam still not extracted. |
| R6 | process | §2.7's follow-up (`AdminButton`/`AdminField`) has no durable home outside the round-1 review file. |

---

## Appendix: new, untriaged

**Empty.** Every observation in this report traces to a round-1 finding, to a fix for one, or to the
D-A11 change I was asked to judge. I opened no new fronts against unchanged code.
