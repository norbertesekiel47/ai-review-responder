# Adversarial Approach Review — #645 Manual Suppression Paths

**Branch:** `feat-645-manual-suppression-paths`  
**Fork point:** `361dd074`  
**Review axis:** approach and underlying assumptions only; this is not a line-level correctness or maintainability review.

## Overall assessment

I would request an approach change before merge, but not a rewrite. The branch has two strong architectural choices: a dedicated correction ledger is more proportionate than forcing accountless compliance events into `account_audit_log`, and the single data-modifying CTE is a sound way to make delete-plus-audit indivisible. The material weakness is the *contents* of the correction ledger. P-2 treats avoiding the offboarding inventory as evidence that tenant provenance should not exist, when that inventory is supposed to follow the data model rather than define it. The implementation then goes further and codifies a column spelling chosen to avoid detection (`src/lib/shared/__tests__/migration-098-suppression-corrections.integration.test.ts:185`).

The recommended shape is still a dedicated, immutable, FK-free table, but it should preserve the deleted row's relevant before-image: a nullable originating account identifier plus the original creator and note. It should then be deliberately classified in offboarding policy. Separately, owner marking should receive a durable account audit event; the analytics event is not an equivalent audit record.

Severity in this report means: **HIGH** = change the design before merge; **MEDIUM** = material lifecycle/audit gap that should be fixed here unless explicitly accepted; **LOW** = clarify or follow up without blocking the core feature; **INFO** = challenged and found sound.

## 1. P-2: no foreign keys is sound; no account provenance is not

### Finding: the offboarding detector is driving the schema instead of checking it — HIGH

P-2 presents two supposedly independent reasons to omit `account_id`: indefinite retention, and the fact that the offboarding detector would then require a disposition (`docs/superpowers/plans/2026-08-03-645-manual-suppression-paths.md:22`). Reason (b) is tail-wagging-dog. A detector is useful when it forces every account-linked record to have a deliberate lifecycle. It is not a reason to make an account-linked fact unrecognizable to the detector.

The implementation makes that inversion unusually explicit. The migration says that adding the column would require inventory and purge verification (`supabase/migrations/098_solicitation_suppression_corrections.sql:21`), while the schema test asserts both the omission and that `removed_by_user_id` is deliberately named so it does not match the detector's `user_id` pattern (`src/lib/shared/__tests__/migration-098-suppression-corrections.integration.test.ts:185`). That is no longer merely avoiding a false positive. It is testing that a generic governance control does *not* see known identity provenance.

The record is also not truly “tenant-less” in every case. P-7 allows correction of either global or account-scoped rows (`docs/superpowers/plans/2026-08-03-645-manual-suppression-paths.md:27`), and an account-scoped suppression necessarily has an account (`supabase/migrations/096_solicitation_suppressions.sql:73`). Once such a row is deleted, the correction row retains its handle, scope, source, and timestamps but cannot answer which account's owner preference was removed (`supabase/migrations/098_solicitation_suppression_corrections.sql:45`). With the same handle potentially suppressed for several accounts, `scope='account'` is not enough. The dead `suppression_id` is a correlation token, not recoverable provenance.

An auditor investigating a removed global opt-out does not always need an originating account: `admin_manual` and some `provider_suppressed` rows legitimately have none. But when one existed, it is relevant evidence. It identifies the sending context that produced the revocation and distinguishes otherwise similar account-scoped rows. The design of record already takes that position for live global rows: it says their `account_id` is provenance, should survive offboarding intact, and can safely point to a tombstoned account (`docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md:520`, `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md:528`). P-2's claim that the provenance ceases to matter merely because an administrator corrected the row conflicts with that established retention model.

Reason (a) identifies a real cost but does not settle the design. This table already creates indefinite retention for the normalized handle because audit usefulness outweighs minimization (`supabase/migrations/098_solicitation_suppression_corrections.sql:49`; `.claude/reference/migrations-log.md:51`). The decision should therefore ask which before-image fields are necessary to explain the removal, then define their lifecycle—not use the deleted parent as proof that all of its provenance has become irrelevant.

### What I would do instead

Keep the new table and keep it free of foreign keys, but add a nullable snapshot such as `originating_account_id UUID` (or simply `account_id`) copied from `DELETE ... RETURNING`. No FK and no cascade are appropriate because the audit record must outlive both the suppression and potentially the account. Add the table explicitly to the account-offboarding inventory with a scope-aware policy:

- for a corrected global row, retain the nullable account provenance using the same tombstoned-account posture as retained global suppressions;
- for a corrected account-scoped owner preference, either scrub the account identifier during offboarding or retain only a tombstoned identifier, depending on the policy choice made explicitly for this audit class;
- teach the detector/inventory about audit identity columns rather than relying on a word-boundary naming accident.

That is the third option the plan did not consider: **snapshot provenance without referential coupling, then classify the snapshot by policy**. It preserves the sound “no FK” decision without erasing useful context. Cost: one migration expansion, CTE/DTO/query/UI updates, and a new offboarding disposition plus purge verification. That is moderate work, but it is exactly the governance work the detector exists to demand.

### Related finding: the correction destroys the original manual-entry evidence — MEDIUM

The correction before-image is narrower than the live record. The admin lookup exposes `account_id`, `created_by_user_id`, and `note` for a live suppression (`src/lib/admin/suppressions-service.ts:71`), but the CTE returns and archives none of them (`src/lib/admin/suppressions-service.ts:197`). This matters most for `admin_manual`: the locked servicing contract requires the originating message reference in `note` as part of the entry's audit evidence (`docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md:600`). Correcting that row permanently destroys both the evidence supporting the original entry and the identity of the person who entered it. The surviving correction tells who removed it and why, but not who asserted the original fact or on what evidence.

I would snapshot nullable `original_created_by_user_id` and `original_note` alongside `originating_account_id`, with no FKs. The cost is additional retained data, which should be acknowledged in the retention table, but the branch already retains the normalized handle indefinitely. If the team decides the message reference is too sensitive to retain, that should be an explicit redaction policy—not an incidental consequence of the correction operation.

## 2. P-1: a dedicated correction table is proportionate — INFO

I do not recommend replacing `solicitation_suppression_corrections` with `account_audit_log`. The existing table structurally represents account-owned lifecycle events: `account_id` is non-null and cascades on account deletion (`supabase/migrations/034_multi_location_schema.sql:62`), and the helper requires an account on every write (`src/lib/audit/log.ts:24`). Making it accept accountless global compliance records would require changing its core ownership semantics, RLS assumptions, helper contract, offboarding behavior, and every consumer's interpretation. That is broader and riskier than adding a small domain audit table.

There is no materially cheaper existing sink that meets §8.2's requirement. Application logs are neither relational nor atomically committed with the delete. Analytics is eventually processed and has a 30/90-day deletion policy (`.claude/reference/migrations-log.md:41`). `approval_audit_log` is a different evidence chain. A generic global compliance-event table could be introduced, but for one event family that is still a new table plus a more abstract schema and lifecycle policy. The dedicated table is the smaller honest abstraction today.

The useful adjustment is therefore to P-1's rationale: the new table is justified by a different ownership and retention domain, not by the claim that correction rows carry no account. It can remain dedicated while carrying nullable, non-FK provenance.

## 3. P-9: the data-modifying CTE is the stronger atomicity boundary — INFO

I found no present failure mode that makes an explicit delete-then-insert transaction preferable.

- **Atomicity and concurrency:** `DELETE ... RETURNING` feeds the insert in one statement (`src/lib/admin/suppressions-service.ts:197`). If the insert fails, PostgreSQL aborts the statement and restores the deleted row; if two admins race, only the statement whose delete matched can insert. The live-DB tests exercise both failure rollback and concurrent correction (`src/lib/admin/__tests__/suppressions-correction.integration.test.ts:350`, `src/lib/admin/__tests__/suppressions-correction.integration.test.ts:483`). An explicit transaction would not improve these properties and would reintroduce a caller-discipline dependency.
- **Partial unique indexes:** they are irrelevant to this statement. The source row is selected by primary key and the destination has no conflicting partial uniqueness. The ledger's partial indexes matter on insertion, not on this deletion.
- **Triggers and RLS:** both apply normally to data-modifying CTE substatements. A trigger error or RLS rejection aborts the whole statement, which is the fail-safe outcome. No current trigger or rule targets these tables. If a future trigger needs to query cross-CTE table state using statement-snapshot semantics, this choice should be revisited, but that is a future coupling—not a current flaw.
- **Replication:** logical/physical replication observes the statement as one committed transaction, just as it would an explicit one-statement transaction. There is no intermediate committed delete to replicate.
- **postgres.js/PgBouncer:** this is one normal tagged-template statement with bound values and explicit UUID casts. The shared client deliberately uses `prepare: false` behind transaction-pooled PgBouncer (`src/lib/db/server.ts:10`, `src/lib/db/server.ts:25`), so the CTE introduces no prepared-statement/session-affinity hazard.

The cost is SQL unfamiliarity and a slightly stronger coupling between the two table shapes. Here that cost is justified: the invariant is visible in the database statement rather than distributed between a service and every caller. I would keep P-9.

## 4. P-4/P-5: different sinks are defensible; treating analytics as the mark audit is not

### P-4 is sound — INFO

Admin correction and owner clearing are both deletion-shaped but have different meanings and lifecycles. A correction invalidates a compliance assertion and may be global/accountless; owner clearing reverses an account owner's private preference and is necessarily tenant-scoped (`docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md:638`). Writing the latter to `account_audit_log` inside the delete transaction (`src/lib/solicitation/contacts-repo.ts:246`) makes account ownership and account-retention behavior structural. Separate sinks are not problematic asymmetry if the code and glossary continue to name the acts distinctly.

### P-5 overstates analytics as audit coverage — MEDIUM

The mark itself is durable while the suppression row exists, including `created_by_user_id`. The problem appears after the owner clears it: the row is deleted, and the clear audit records the remover and deleted entity ID but not the original marker (`src/lib/solicitation/contacts-repo.ts:255`). P-5 says the `solicitation_suppressed` analytics event covers creation (`docs/superpowers/plans/2026-08-03-645-manual-suppression-paths.md:25`), but that event does not pass `userId` even though the analytics API supports it (`src/lib/solicitation/suppression.ts:262`; `src/lib/analytics/enqueue.ts:8`), and completed analytics events are deleted after 30 days (`.claude/reference/migrations-log.md:41`). It is observability, not a durable actor audit.

This is not necessarily a statutory gap—the owner mark is explicitly a private preference, not a recipient opt-out—but it is a design consistency gap. The branch has decided that clearing the preference is important enough to audit forever. After a clear, the system can prove who cleared an opaque suppression ID but not who created that preference or when. The next engineer is likely to read the “analytics is coverage” comments at `src/lib/solicitation/contacts-repo.ts:198` and incorrectly infer equivalent retention and actor semantics.

I would write `solicitation_do_not_contact_marked` to `account_audit_log` in the existing transaction only when `recordSuppression` actually inserts a row. Cost: one account-audit call, tests, and a documented event name; no new table or transaction. Keep the analytics event for product telemetry, but stop using it as the reason not to audit.

## 5. The §7.4 display mapper is a good privacy leaf, not the complete #629 seam — LOW

The closed output is a sound privacy boundary for its current job. It makes the owner-visible result incapable of carrying `account_id` or source detail and faithfully distinguishes a global opt-out from the owner's account preference (`src/lib/solicitation/suppression.ts:95`). That directly serves §7.4's cross-tenant rule (`docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md:616`). I would retain this projection or an equivalent one.

The overreach is calling it a shared, current seam for #629. The comment says there are “two consumers today” (`src/lib/solicitation/suppression.ts:109`), but the Requests surface is explicitly a future ticket, and the intake says rendering it is a non-goal (`.feature/intake.json:8`). The present production consumer is the contacts list. More importantly, #629's contract is larger than four display keys: it must distinguish terminal dispatch suppression from build-time withholding and perform a read-time suppression join for pending asks (`docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md:336`, `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md:767`). `toSuppressionDisplay` maps only a current live ledger match.

It is also slightly contacts-specific: `clearableByOwner` and the account detail “You can undo this” assume the surface offers the §7.6 clear action (`src/lib/solicitation/suppression.ts:115`, `src/lib/solicitation/suppression.ts:135`). The approval surface may need to explain status without offering preference management.

I would rename/document this as a live-ledger privacy projection, not the complete #629 view model. Ticket #629 should compose it with ask lifecycle state and choose surface-specific action/copy. If reuse is desired, a semantic closed union such as `recipient_opt_out | owner_do_not_contact` is a more stable core; each surface can derive whether it exposes a clear action. Cost is low now (mostly naming and contract clarification) and higher if deferred until a second caller has coupled itself to the contacts-specific object.

## 6. Triaged deviations

Most ACCEPT verdicts are reasonable within this branch. D-A1/A2/A3/A4/A6/A7 are mechanical or correctness-preserving responses; D-A9 correctly accepts the local rename while explicitly promoting the underlying harness collision; D-A10 is an estimation failure, not evidence by itself that a completed cohesive feature should be torn apart (`docs/superpowers/plans/feat-645-manual-suppression-paths-deviations.md:292`). Two verdicts need qualification:

1. **D-A5 is only conditionally ACCEPT.** Updating the stale allowlist entry was correct, but its statement that the corrections table is “correctly” outside tenant inventory depends entirely on P-2 (`docs/superpowers/plans/feat-645-manual-suppression-paths-deviations.md:110`). If the correction snapshot gains originating-account provenance, this part must be reopened and the table deliberately classified. The deviation fix itself remains valid.
2. **D-A8 should be PARTIAL ACCEPT.** Adding a distinct confirmation before clearing fixes the dangerous omission. But the deviation's own analysis says marking is the safe, reversible direction and that guarding it is backwards (`docs/superpowers/plans/feat-645-manual-suppression-paths-deviations.md:195`). The resolution adds the missing clear confirmation while retaining the unnecessary mark confirmation. I would keep confirmation for clear and remove it for mark. Cost: a small UI/test adjustment; benefit: less friction on the safety-increasing action. This is low severity and not a compliance blocker.

D-A9's harness collision should remain a separately owned follow-up; accepting the rename must not let the explicit recurrence risk at `docs/superpowers/plans/feat-645-manual-suppression-paths-deviations.md:243` disappear from tracking.

## Recommended disposition

Before merge, I would make one cohesive audit-model change:

1. Extend `solicitation_suppression_corrections` with nullable, non-FK snapshots for the originating account, original creator, and original note.
2. Copy them in the existing data-modifying CTE and expose them in the admin-only correction history as appropriate.
3. Add an explicit offboarding classification and scope-aware retention/scrub verification for the correction table; strengthen the detector so identity-column naming cannot silently exempt a table.
4. Add a same-transaction account audit event for a newly-created owner manual mark.

Keep the dedicated table, P-4's separate owner-clear sink, P-9's single statement, P-10's decision not to dual-write correction analytics, and the closed owner-facing privacy projection. Clarify the latter's scope before #629 consumes it.

## TOP FINDINGS

HIGH | `supabase/migrations/098_solicitation_suppression_corrections.sql:21` | P-2 lets offboarding-detector avoidance drive the schema and makes account-scoped corrections lose their originating account.

HIGH | `src/lib/shared/__tests__/migration-098-suppression-corrections.integration.test.ts:185` | The schema test deliberately enshrines identity-column naming that evades the governance detector instead of classifying the data.

MEDIUM | `src/lib/admin/suppressions-service.ts:197` | Correction snapshots omit the original creator and required manual-entry note, destroying the evidence behind the corrected assertion.

MEDIUM | `src/lib/solicitation/contacts-repo.ts:198` | Owner marking relies on expiring, actorless analytics, so clearing leaves no durable record of who created the preference.

LOW | `src/lib/solicitation/suppression.ts:109` | The privacy projection is sound, but it has one current caller and does not cover #629's terminal-state/read-time-join contract.

LOW | `docs/superpowers/plans/feat-645-manual-suppression-paths-deviations.md:195` | D-A8 should be PARTIAL ACCEPT: keep confirmation on clear, but remove friction from the safe mark action.

INFO | `supabase/migrations/098_solicitation_suppression_corrections.sql:5` | A dedicated domain audit table is proportionate; generalizing account_audit_log would be a broader and riskier change.

INFO | `src/lib/admin/suppressions-service.ts:197` | P-9's single data-modifying CTE is sound under the current schema; no partial-index, trigger, RLS, replication, or postgres.js regression was found.
