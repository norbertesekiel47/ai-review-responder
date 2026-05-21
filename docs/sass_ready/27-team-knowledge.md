# Spec 27 — Team & Knowledge Management

> **Goal:** First hire is CS/Support generalist at $20–30k MRR; onboarding doc maintained even when solo; bus-factor mitigated with emergency-access plan; engineering #2 follows at $50k+ MRR.

---

## 1. Why this matters

Solo founders break under one of two pressures: customer support volume or context-loss disaster (laptop stolen, hospitalization, family emergency). Both have known, cheap mitigations. Skip them and the business is a single point of failure.

## 2. Current state (RepWorth)

- Solo founder (Norbert).
- No emergency-access plan documented.
- No onboarding doc.
- No `docs/onboarding/new-hire.md`.

## 3. Target state

### Hiring sequence
| Trigger | Role | Why |
|---|---|---|
| **$20–30k MRR** | Customer Success / Support generalist | Volume of email + chat + onboarding exceeds founder bandwidth |
| **$50k+ MRR** | Engineering #2 (fullstack generalist) | CS no longer drowning + founder bottlenecked on shipping |
| **$100k+ MRR** | First specialist (DevRel or Sales) | Specific channel is now the largest growth lever |

Avoid hiring a "VP of X" early — generalists who own end-to-end deliver more.

### Onboarding doc
**`docs/onboarding/new-hire.md`** — maintained now, even alone:
- **Local dev setup**: clone, install, env vars, mock-mode toggle, first `pnpm dev`.
- **Runbook tour**: pointer to `docs/runbooks/`.
- **Architecture orientation**: `CONTEXT.md` (when written, [Spec 25](./25-documentation.md)) + `CLAUDE.md`.
- **Week-1 task**: ship a small PR end-to-end by Friday. Suggested first tasks list maintained.
- **Who-to-ask-about-what map** (currently just "Norbert"; expands as team grows).
- **Access checklist**: GitHub, Vercel, Railway, Supabase, Stripe (test), Help Scout, BetterStack, Sentry, PostHog, 1Password vault.

The doc is also **your "if I lose my laptop" recovery doc** — write it for yourself first.

### Bus-factor / emergency access
**Required by first paid customer.**

- **1Password / Bitwarden Emergency Access** set up:
  - Trusted contact (family member, attorney, or co-founder if applicable).
  - 7-day waiting period (so accidental triggers are recoverable).
  - Grants full vault access in emergency.
- **Sealed envelope** with:
  - Master password to 1Password.
  - Recovery codes for Stripe, Supabase, Vercel, Railway, GitHub, bank, Google Workspace.
  - Held by trusted attorney or family member.
- **`docs/runbooks/emergency-access.md`**: what trusted contact should do if founder is unavailable — customer notification template, attorney contact, retention-data-only-for-90-days policy.

### Knowledge management
- **Docs-as-code**: all knowledge in repo (`docs/`) or in shared SaaS tools (Help Scout, Notion).
- **No tribal knowledge in private DMs or solo Notion accounts.**
- **Audit log**: who has access to what, reviewed quarterly. `docs/security/access-checklist.md` ([Spec 09](./09-security-compliance.md)).

### Time-off / on-call
- Solo: status-page-honest about on-call hours; not 24/7.
- After first hire: shared on-call rotation; founder takes weekends + after-hours for first 6 months.
- Document on-call expectations in `docs/runbooks/oncall.md`.

### Compensation philosophy
- First hire: market-rate base + small equity (1–3% over 4 years).
- Salary band published internally (transparency).
- Remote-first; async-default; one in-person off-site per year when team > 3.

### Hiring process (when triggered)
1. Job description (clear outcomes, not qualifications list).
2. Async take-home (paid, 4-hour cap).
3. Working session (2-hour pair on a real problem).
4. Reference checks (3 references, actually call them).
5. Offer + 7-day decision window.

Total time: 2 weeks from JD to offer. Document in `docs/hiring/process.md` when first hire triggered.

### Performance & culture
- Quarterly 1:1 review (sub-day cadence weekly).
- Public weekly engineering note from each person in `docs/weekly/<person>/YYYY-Wxx.md`.
- Blameless culture: incidents and bugs reviewed for systems, not people.

### Offboarding
- Offboarding checklist: revoke access, transfer ownership, exit interview.
- `docs/hiring/offboarding-checklist.md` for when needed.

## 4. Implementation tasks

1. Author `docs/onboarding/new-hire.md` skeleton today. Maintain quarterly.
2. Set up 1Password Emergency Access for trusted contact. Test once.
3. Prepare sealed envelope with master password + critical recovery codes. Deliver to attorney or trusted contact.
4. Author `docs/runbooks/emergency-access.md` — what trusted contact should do.
5. Author `docs/security/access-checklist.md` — list of every service + who has access. Review quarterly.
6. Set status-page-honest on-call windows ([Spec 08](./08-reliability-sre.md)).
7. Set hiring trigger calendar reminders at $20k MRR and $50k MRR milestones.
8. Draft generic JD for "Customer Success Generalist" so when trigger fires, it's ready to post.
9. Author `docs/runbooks/oncall.md` (solo + future-state).

## 5. Acceptance criteria

- [ ] `docs/onboarding/new-hire.md` exists with all sections populated.
- [ ] 1Password Emergency Access configured.
- [ ] Sealed envelope delivered.
- [ ] `docs/runbooks/emergency-access.md` exists.
- [ ] `docs/security/access-checklist.md` exists; quarterly review calendar entry.
- [ ] Hiring trigger calendar reminders set.
- [ ] Customer Success JD drafted (not posted yet).
- [ ] On-call windows published on status page.

## 6. Metrics

| Metric | Target |
|---|---|
| Onboarding-doc freshness | ≤ 90 days since last update |
| Bus-factor: people who can access prod | ≥ 2 (founder + emergency contact path) |
| Quarterly access review completion | 100% |
| Hiring trigger response | Within 30 days of trigger MRR |
| Time-to-productivity (when first hire lands) | First PR shipped within week 1 |

## 7. Risks & mitigations

- **Risk:** Emergency-access plan triggered accidentally. **Mitigation:** 7-day waiting period; founder can cancel.
- **Risk:** First CS hire underperforms; rehiring loop is expensive. **Mitigation:** paid take-home + working session + references. Be willing to fire fast (90-day mark).
- **Risk:** Knowledge concentrated in founder's head. **Mitigation:** docs-as-code culture; weekly notes; runbook discipline.

## 8. Dependencies & cross-links

- [Spec 08 — Reliability](./08-reliability-sre.md) (on-call docs)
- [Spec 09 — Security & Compliance](./09-security-compliance.md) (access checklist, vendor risk)
- [Spec 13 — Customer Support](./13-customer-support.md) (CS-hire role definition)
- [Spec 25 — Documentation](./25-documentation.md) (CONTEXT.md cross-link)
- [Spec 26 — Financial Operations](./26-financial-operations.md) (MRR triggers)
