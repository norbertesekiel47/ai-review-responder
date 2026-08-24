# F2 — The admin action surface, after four consolidations

Merges `757bf639` (#880), `2a9ede74` (#886), `1e407fee` (#909), `efd2145d`
(#893) — all 2026-08-23, within 15 minutes of one another.

**Representative action: the admin Halt latch.** An operator on
`/admin/businesses/[id]` types a note and stops a customer's solicitation send
batch. It is the only mutating admin action that crosses more than one seam and
reaches a DB write, an audit-log write and AAL2.

## Flowchart

```mermaid
flowchart TD
    subgraph RENDER["Server render"]
        P1["AdminBusinessDetailPage<br/>page.tsx:13"]
        P2["requireAdminPage aal2=false<br/>page-gate.ts:39"]
        P5["readAdminBatchSummary<br/>batch-view.ts:938"]
        P7["SolicitationBatchPanel<br/>SolicitationBatchPanel.tsx:235"]
    end

    subgraph S893["SEAM #893 — read fan-out rule · ci:pool-fanout"]
        P3["getBusinessDetail<br/>business-detail-service.ts:26"]
        P4["batch1 then batch2, SEQUENTIAL<br/>business-detail/queries.ts:88,205"]
        X1["scanned, 0 findings<br/>pool-fanout-audit.ts:142"]
    end

    subgraph S880["SEAM #880 — useAdminActionForm"]
        F1["useAdminActionForm<br/>SolicitationBatchPanel.tsx:244"]
        F3["form.clearOutcome<br/>useAdminActionForm.ts:162"]
        F5["form.run — dispatch start<br/>useAdminActionForm.ts:166"]
        F6["reducer start/stop<br/>useAdminActionForm.ts:99"]
        F7["form.succeed / form.fail<br/>SolicitationBatchPanel.tsx:302,310"]
    end

    subgraph WIRE["Transport — deliberately NOT in #880"]
        T1["fetch POST admin/solicitation/batch/halt<br/>SolicitationBatchPanel.tsx:288"]
        B1["refusalCopy / successCopy<br/>SolicitationBatchPanel.tsx:167,186"]
    end

    subgraph S909["SEAM #909 — gate → parse → 400 preamble"]
        G0["withSameOrigin(halt)<br/>halt/route.ts:150"]
        G1["requireAdminJson<br/>halt/route.ts:107"]
        G3["requireAdminWithAal2<br/>admin-mfa-gate.ts:55"]
        G4["requireRole admin<br/>admin-mfa-gate.ts:60"]
        G5["requireCurrentAal2FromSupabase<br/>admin-mfa-gate.ts:73"]
        G6["400 invalid_body<br/>admin-mfa-gate.ts:136"]
        G7["400 first issue<br/>admin-mfa-gate.ts:147"]
    end

    subgraph DOMAIN["Domain — owned by NONE of the four seams"]
        D2["adminHaltBatch<br/>approval.ts:729"]
        D3["sql.begin<br/>approval.ts:734"]
        D4["lockBatchForAction<br/>approval.ts:735"]
        D6["latchHalt — the one private latch<br/>approval.ts:525"]
        D7["CAS UPDATE solicitation_batches<br/>approval.ts:528"]
        D8["UPDATE outreach → cancelled<br/>approval.ts:543"]
        D9["writeAccountAuditLog on tx<br/>approval.ts:559"]
        D10["recordStep batch_halted<br/>approval.ts:578"]
        D11["closeBatchIfSettled<br/>approval.ts:590"]
        D12["toWire whitelist<br/>halt/route.ts:88"]
    end

    subgraph S886["SEAM #886 — useLaneWrites · NOT REACHABLE FROM ADMIN"]
        L3["ApprovalPanel — OWNER dashboard<br/>ApprovalPanel.tsx:622"]
        L1["useLaneWrites<br/>lane-writes.ts:388"]
        L2["postLaneAction — busy+error+fetch<br/>lane-writes.ts:210"]
        L5["haltBatch owner arm<br/>approval.ts:644"]
    end

    P1 --> P2 --> P3 --> P4 --> P5 --> P7
    P4 -.guarded by.-> X1
    P7 --> F1 --> F3 --> F5 --> F6
    F5 --> T1 --> G0 --> G1 --> G3
    G3 --> G4
    G3 --> G5
    G1 -->|unreadable body| G6
    G1 -->|schema refusal| G7
    G1 -->|ok| D2 --> D3 --> D4 --> D6
    D6 --> D7 --> D8 --> D9 --> D10 --> D11
    D6 --> D12 --> B1 --> F7 --> F6
    G6 --> B1
    G7 --> B1

    L3 --> L1 --> L2 --> L5 --> D6
```

**The only place the admin lane and the `#886` lane meet is `latchHalt`
(`approval.ts:525`) — inside the domain, below all four seams.**

## The four seams

| Seam | Owns | Entry point | CI audit |
|---|---|---|---|
| **#880** `useAdminActionForm` | one submit form's client state + transition ordering; **refuses** the fetch (`:40-44`) | `src/hooks/useAdminActionForm.ts:137` | **none** |
| **#886** `useLaneWrites` | four owner lane verbs, transport, refusal-copy tables, own busy/error | `dashboard/requests/lane-writes.ts:388` | **none** |
| **#893** fan-out rule | "no `Promise` combinator with ≥2 DB-issuing elements" over `src/lib/{admin,dashboard,locations}` | `scripts/ci/pool-fanout-audit.ts:142` (a rule, not an import) | itself |
| **#909** `requireAdminJson` | gate + `request.json()` + `safeParse` + both 400 shapes, all with `NO_STORE_HEADERS` | `src/lib/auth/admin-mfa-gate.ts:124` | `ci:admin-aal2` |

`#909` did **not** land in `src/app/api/_shared/` — no new file was created; the
composition was added beside the gate it composes. `ci:admin-aal2` gained
`GATE_JSON_FN` (`admin-aal2-audit.ts:181`), which is the half that made the
extraction legal: the identical helper was built and reverted during #898 for
want of it (`admin-mfa-gate.ts:99-101`).

## Convergence verdict — seed 3 REFUTED

**They compose cleanly. The seed's premise is measurably wrong: the four merges
are not four consolidations of one surface.** No admin route crosses four
abstractions. **No file in the repo imports from more than one of the four
seams.**

| Seam | Importers | Directory |
|---|---|---|
| `useAdminActionForm` | 5 | `src/app/admin/**` |
| `requireAdminJson` | 3 | `src/app/api/admin/**` |
| `useLaneWrites` | 2 | `dashboard/requests/` — **owner, not admin** |
| `ci:pool-fanout` | 0 — a rule | `src/lib/{admin,dashboard,locations}` |

Three stack in strictly disjoint layers of one request: client submit state →
route preamble → data access. Each layer's seam hands a value to the next
layer's *entry point*, never to another seam. The fourth is on a different
surface with a different trust model and is unreachable from any admin route.

Two seams meeting at the `fetch` boundary is the maximum crossing that exists in
this codebase today.

## Layering findings

1. **Two owners for one client submit concern.** `#880` owns state and refuses
   transport; `#886` owns transport **and** state. Authored eight minutes apart,
   neither references the other, **neither is CI-guarded**. Plausibly legitimate
   specialization — but nobody recorded the decision.
2. **`#909` migrated 3 of 25 admin mutation routes.** Byte-shape-identical
   duplicates at `grant-extension/route.ts:41-58` and
   `impersonation/start/route.ts:26-49`; a **divergent** third at
   `ranking/route.ts:24-43` (different strings, no `NO_STORE_HEADERS`). Eight
   more call `request.json()` raw. `ci:admin-aal2` accepts all — it checks a gate
   is *reached*, never that the preamble is the shared one.
3. **No unstated ordering between seams.** The one intra-seam ordering (the
   double clear at `SolicitationBatchPanel.tsx:268` plus the `start` reducer arm)
   is redundant but harmless, and its reason is written at
   `useAdminActionForm.ts:55-61`.
4. **No leaks.** `useAdminActionForm.ts` imports only `react`;
   `admin-mfa-gate.ts` only auth + zod + constants; `pool-fanout-audit.ts` names
   no seam; `lane-writes.ts` only solicitation types.
5. **One untyped cross-seam coupling at the wire.**
   `SolicitationBatchPanel.tsx:177` branches on `httpStatus === 401 || 403`,
   encoding knowledge of `requireAdminJson`'s gate arms as raw numbers.
   Documented at `:111-114`, correct today, typed nowhere.

## Side effects

All DB writes inside one `sql.begin` (`approval.ts:734`): the batch CAS
(monotone, no un-halt), outreach → `cancelled` for `rendered`/`queued` only
(`sending` deliberately excluded), `recordStep`, and the settlement join.

`writeAccountAuditLog` runs **on `tx`** in the same transaction
(`approval.ts:559`) through the single owner — invariant satisfied.
`actorUserId` comes from `gate.admin.id`, never the body; `z.strictObject`
rejects extra fields, so a caller cannot name its own `halted_by`. The operator's
note is omitted from the log line (`halt/route.ts:119-124`).

**Worth stating plainly:** the page rendering the panel is **AAL1**
(`page.tsx:23`). An admin without step-up can **read** a customer's batch state,
counts and halt history; only the stop requires AAL2. This is correct under
`ci:admin-aal2`'s parity rule, since the sibling GET uses `requireRoleOr401`.

## Gaps

`getBusinessChannelEnrollments`, `mapBusinessDetailResponse` and
`closeBatchIfSettled` internals not read — off the seam question. The other four
`#880` surfaces were verified by their hook line and fetch URL, not read in full.
`ci:pool-fanout`'s deferred-await blind spot (`pool-fanout-audit.ts:113-127`)
means no combinator form exists, but a hand-scan for the deferred form was not
done.
