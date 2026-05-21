# Spec 21 — Mobile

> **Goal:** Mobile-first responsive web that approves in 2 taps from a push notification, PWA installable, native iOS/Android on the 18-month roadmap, SMS approval flow tested with real SMB owners.

---

## 1. Why this matters

The SMB owner approving a response is doing it on her phone between customer appointments. If approval takes more than 5 seconds, she'll let drafts pile up and the activation/retention loop breaks.

## 2. Current state (RepWorth)

- Dashboard redesigned (PR #27); responsive but not phone-first-tested.
- SMS approval implemented (Phase 1 design `docs/plans/2026-04-21-phase1-sms-design.md`).
- Telegram approval implemented (Phase 2 `docs/plans/2026-04-22-telegram-phase-2-design.md`).
- WhatsApp Phase 3 planned.
- No PWA manifest visible.
- No native iOS/Android apps.

## 3. Target state

### Mobile-first web
- **Mobile-first responsive design.** Approve in **2 taps from notification**:
  - Tap 1: open notification → land on response detail page.
  - Tap 2: tap "Approve & Publish".
- Reject / edit also accessible in 2–3 taps.
- Test weekly on **real iPhone SE (small viewport)** and a **low-end Android** (e.g., Pixel 4a).

### PWA
- Add Web App Manifest (`public/manifest.json`) + service worker (`public/sw.js`).
- Install prompt for owners who use RepWorth daily (heuristic: 7+ logins in 14 days).
- Offline mode: read-only view of pending drafts; approve action queued + flushed on reconnect.

### Native iOS/Android
- **PWA covers 80% of value for first 18 months.**
- Native triggers:
  - Daily active users > weekly active users (signal: mobile is primary surface).
  - Offline-drafting use case validated.
- Tech: **React Native** or **Expo** to share components.
- Push notifications via APNs / FCM at native ship.

### Push notifications
- **Web push from PWA + email + optional SMS day 1.**
- Native push follows native apps.
- Notification triggers:
  - New low-rating review (≤ 3 stars) needs approval.
  - Draft approved by teammate awaits owner review.
  - Subscription past_due day 1, 3, 5.
- Quiet hours: respect user's locale TZ + Settings → Notifications → Quiet hours.

### SMS approval flow (real-owner tested)
- **Test with 5 actual SMB owners, not your friends.**
- Mechanics:
  - SMS contains: review excerpt, draft response, signed approval token URL, `Reply YES to approve`, `Reply EDIT for the link`, `Reply NO to reject`.
  - Reply parsing: case-insensitive, tolerant of typos (`Y`, `yes!`, `approve`).
  - Multi-review batching: if multiple drafts pending, send list with numbered options.
  - Opt-out: `STOP` per Twilio compliance.
- Pain-test edge cases:
  - Ambiguous "yes" interpretation (which review?).
  - Conversation history (owner replies an hour later).
  - Multi-location owner switching contexts.

### Telegram + WhatsApp approval
- Already designed; same approval-token + audit pattern.
- Channel chosen at Settings → Notifications.

### Mobile-specific UX patterns
- **Bottom navigation** on mobile (thumb-reachable).
- **Sticky approve/reject** buttons on response detail page.
- **Swipe gestures** on review list (swipe-right = mark reviewed, swipe-left = generate draft).
- **Larger touch targets** (≥ 44×44pt).

## 4. Implementation tasks

1. Audit dashboard for mobile experience. Identify any > 2-tap approval path. File issues.
2. Add `public/manifest.json` and basic service worker. Test installability on iOS + Android.
3. Implement web push subscription flow. Wire to `worker/jobs/notification/*`.
4. Update notification preferences in Settings → Notifications: email / SMS / Telegram / WhatsApp / web push / native push (when shipped). Per-channel toggles.
5. Conduct **5 real SMB owner SMS tests**. Capture pain points in `docs/research/sms-approval-feedback-YYYY-MM.md`. Fix top 3.
6. Build offline read-only mode in PWA (cache last 50 reviews + drafts).
7. Build approve-action queue: tap Approve while offline → action stored locally → flushed on reconnect.
8. Set mobile-test cadence: weekly smoke on iPhone SE + Pixel 4a. Add to `docs/runbooks/smoke-test-checklist.md`.
9. Native iOS/Android roadmap doc in `docs/plans/native-apps-roadmap.md` — trigger conditions, tech-stack decision.

## 5. Acceptance criteria

- [ ] Approve-response path is ≤ 2 taps from notification on iOS Safari + Chrome Android.
- [ ] PWA installable on both platforms.
- [ ] Offline mode shows last 50 reviews; approve queues + flushes on reconnect.
- [ ] Web push subscription functional with quiet-hours respected.
- [ ] 5 real-owner SMS tests completed; feedback captured + top 3 fixes shipped.
- [ ] Lighthouse Mobile Performance ≥ 90 on dashboard home.
- [ ] All 4 mobile-UX patterns (bottom nav, sticky approve, swipe gestures, touch targets) on response detail page.

## 6. Metrics

| Metric | Target |
|---|---|
| Approve-time-from-notification (median) | < 5 seconds |
| PWA install rate (active users) | ≥ 30% |
| SMS approval reply success rate | ≥ 95% |
| Mobile Lighthouse Performance | ≥ 90 |
| Mobile DAU/WAU ratio | Tracked; > 70% triggers native-app evaluation |

## 7. Risks & mitigations

- **Risk:** SMS approval misinterprets ambiguous reply. **Mitigation:** confirmation reply for ambiguous cases ("Do you mean the 1-star review from John? Reply YES to confirm.").
- **Risk:** Push notification fatigue. **Mitigation:** quiet hours + per-channel toggles + smart bundling (multiple low-rating drafts → single notification).
- **Risk:** Offline approve flushes a stale draft. **Mitigation:** include draft hash in queued action; reject + alert if draft changed on server.

## 8. Dependencies & cross-links

- [Spec 04 — Auth & Identity](./04-auth-identity.md) (approval token model)
- [Spec 06 — Onboarding](./06-onboarding-activation.md) (notification setup in checklist)
- [Spec 10 — Trust & Safety](./10-trust-safety.md) (Twilio compliance, STOP)
- [Spec 22 — AI/LLM Operations](./22-ai-llm-ops.md) (draft generation feeding the notification)
- Code anchors: `docs/plans/2026-04-21-phase1-sms-design.md`, `docs/plans/2026-04-22-telegram-phase-2-design.md`, `docs/plans/2026-04-23-whatsapp-phase-3-design.md`
- Architecture invariant: "Approval tokens never stored raw" (CLAUDE.md)
