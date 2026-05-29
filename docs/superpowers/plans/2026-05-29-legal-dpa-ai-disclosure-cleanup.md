# Legal content cleanup (DPA + AI-disclosure) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reword the `/legal/dpa` placeholder to a non-misleading "available on request" stub, and remove the leaked in-product AI-draft disclosure microcopy from the Terms, Privacy, and AUP legal documents.

**Architecture:** Content-only edits to the typed legal document map `src/lib/legal/content.ts` (rendered as-is by the already-branded `src/components/legal/LegalPage.tsx`), guarded by a new regression test in `src/lib/legal/__tests__/content.test.ts`. No routes, components, styling, or behavioral code paths change.

**Tech Stack:** TypeScript, Vitest. Spec: `docs/superpowers/specs/2026-05-29-legal-dpa-ai-disclosure-cleanup-design.md`.

**Worktree/branch:** `fix/launch-p0-11-legal-dpa-ai-disclosure` (isolated worktree, created via superpowers:using-git-worktrees at execution time).

---

### Task 0: Land the spec on the branch

**Files:**
- Already created: `docs/superpowers/specs/2026-05-29-legal-dpa-ai-disclosure-cleanup-design.md`

- [ ] **Step 1: Commit the spec as the first commit on the worktree branch**

```bash
git add docs/superpowers/specs/2026-05-29-legal-dpa-ai-disclosure-cleanup-design.md \
        docs/superpowers/plans/2026-05-29-legal-dpa-ai-disclosure-cleanup.md
git commit -m "docs(legal): spec + plan for DPA reword & AI-disclosure cleanup (P0 #11)"
```

---

### Task 1: Clean the legal content (TDD)

**Files:**
- Test: `src/lib/legal/__tests__/content.test.ts` (add two `it` blocks + one import)
- Modify: `src/lib/legal/content.ts` (4 edits: Terms `:95-100`, Privacy `:175-177`, AUP `:256-262`, DPA `:276-283`)

- [ ] **Step 1: Write the failing test**

Add this import at the top of `src/lib/legal/__tests__/content.test.ts` (below the existing `import { legalDocs } from '../content';`):

```ts
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';
```

Add these two tests inside the existing `describe('legal content', () => { ... })` block:

```ts
  it('does not leak the in-product AI-draft disclosure into legal prose', () => {
    for (const slug of ['privacy', 'aup', 'terms'] as const) {
      const bodies = legalDocs[slug].sections.flatMap((section) => section.body ?? []);
      expect(bodies).not.toContain(AI_DRAFT_DISCLOSURE);
    }
  });

  it('publishes a non-misleading, on-request DPA', () => {
    const dpa = legalDocs.dpa;
    const headings = dpa.sections.map((section) => section.heading);
    const bodyText = dpa.sections
      .flatMap((section) => section.body ?? [])
      .join(' ')
      .toLowerCase();

    expect(headings).toContain('Requesting a DPA');
    expect(headings).not.toContain('Status');
    expect(bodyText).not.toContain('pending');
    expect(bodyText).not.toContain('should not treat');
    expect(bodyText).toContain('request our dpa');
    expect(bodyText).toContain('info@repworth.net');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/legal/__tests__/content.test.ts`
Expected: FAIL — both new tests fail (the disclosure string is still present in privacy/aup/terms; the DPA still has a `Status` heading with "pending"/"should not treat" copy).

- [ ] **Step 3: Apply the content edits**

Edit 1 — Terms "AI-Generated Content" (`content.ts:95-100`), remove the leaked first line:

```ts
      {
        heading: 'AI-Generated Content',
        body: [
          'Response drafts are suggestions only. RepWorth does not warrant their accuracy, appropriateness, tone, completeness, or fitness for any purpose. You are responsible for reviewing all drafts before approving them for posting to Google.',
        ],
      },
```

Edit 2 — Privacy "How We Use Data" (`content.ts:176-177`), empty the leaked body (keep bullets):

```ts
      {
        heading: 'How We Use Data',
        body: [],
        bullets: [
```

Edit 3 — AUP "Review and Approval Responsibility" (`content.ts:256-262`), remove the leaked first line:

```ts
      {
        heading: 'Review and Approval Responsibility',
        body: [
          'Owners are responsible for reviewing each draft before approval and for ensuring posted responses are accurate, lawful, and appropriate for their business.',
        ],
      },
```

Edit 4 — DPA "Status" → "Requesting a DPA" (`content.ts:276-283`), reword to on-request stub:

```ts
      {
        heading: 'Requesting a DPA',
        body: [
          'RepWorth provides a Data Processing Addendum to customers who require one for their compliance needs.',
          'To request our DPA, email info@repworth.net and we will provide the current addendum for your review and signature.',
        ],
      },
```

Leave the DPA "Processing Scope" and "Sub-processors" sections unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/lib/legal/__tests__/content.test.ts`
Expected: PASS — all four tests (two pre-existing + two new) pass.

- [ ] **Step 5: Run the full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: lint 0 errors, typecheck clean, full suite green. (No DB/RLS/tenant-scope surface is touched, so the DB CI scripts are not required.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/legal/content.ts src/lib/legal/__tests__/content.test.ts
git commit -m "fix(legal): reword DPA to on-request stub + drop leaked AI-disclosure microcopy (P0 #11)"
```

---

## Self-Review

- **Spec coverage:** AI-disclosure removal from Privacy (`:177`), AUP (`:259`), and Terms (`:97`) → Task 1 Step 3 Edits 1–3 + the "does not leak" test. DPA reword → Edit 4 + the "on-request DPA" test. URL retention → no route change (the `/legal/dpa` page still renders `legalDocs.dpa`). All spec items covered.
- **Placeholder scan:** No TBD/TODO; every step shows the exact code and command.
- **Type consistency:** `section.body ?? []` matches the typed `LegalSection` shape used throughout `content.ts`; `AI_DRAFT_DISCLOSURE` is the exported constant from `src/lib/ui/disclosures.ts`. The reworded body contains the literal `"To request our DPA, email info@repworth.net…"`, so the lowercased assertions `request our dpa` and `info@repworth.net` hold.

## Finishing

After Task 1, follow superpowers:finishing-a-development-branch to push the branch and open a PR (target `main`; 4 CI checks must be green). Then update `docs/launch-ready-part2.md` P0 #11 with a ✅ + PR reference, consistent with prior entries.
