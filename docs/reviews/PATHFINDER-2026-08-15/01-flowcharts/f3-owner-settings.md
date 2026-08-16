# F3 — Owner settings & policy configuration

Pathfinder 2026-08-15, Phase 1 flowchart. Boundaries per
`docs/reviews/PATHFINDER-2026-08-15/00-features.md` (F3 row + adjustments 1 and 4
+ the two do-not-unify entries).

**Charted in full:** the `/settings/*` shell, the auto-approval read + write
lanes, the brand-voice read + write lanes.
**Charted compactly:** competitors, locations, profile, billing, security.
**Not charted (external):** `settings/channels` (F4), `src/lib/auth/**` (S1),
`/api/billing/*` (F6), `/api/account/offboarding/*` (offboarding).

---

## Flowchart

```mermaid
flowchart TD

%% ─────────────────────────── SHELL ───────────────────────────
subgraph SHELL["Settings shell"]
  LAYOUT["SettingsLayout — two-column shell<br/>src/app/(authenticated)/settings/layout.tsx:5"]
  SIDEBAR["SettingsSidebar — 8 tabs, 2 groups, client nav<br/>src/components/dashboard/settings/SettingsSidebar.tsx:47"]
  ACTIVE["resolveActiveHref — /settings maps to /settings/voice<br/>src/components/dashboard/settings/SettingsSidebar.tsx:41"]
  INDEX["SettingsIndexPage — redirect to /settings/voice<br/>src/app/(authenticated)/settings/page.tsx:3"]
  ERRBND["SettingsError — segment error boundary<br/>src/app/(authenticated)/settings/error.tsx:5"]
  SHELLUI["SettingsShell — save bar + saved flash<br/>src/components/dashboard/settings/SettingsShell.tsx:20"]
end

LAYOUT --> SIDEBAR
SIDEBAR --> ACTIVE
INDEX --> LAYOUT
LAYOUT --> ERRBND

%% ─────────────────────── S1 AUTH SEAM (reference) ───────────────────────
subgraph S1["S1 auth seam — referenced, not charted"]
  ROA["requireOwnerAccess — server-component gate, cookie location scope<br/>src/lib/auth/require-owner-access.ts:42"]
  RR401["requireRoleOr401 — owner role or 401<br/>src/lib/auth/route-helpers.ts:140"]
  ROWA["requireOwnerWithAccount — role + account_id, NO writable gate<br/>src/lib/auth/route-helpers.ts:167"]
  RWO["requireWritableOwner — + assertWritableSubscriptionForAccount<br/>src/lib/auth/route-helpers.ts:187"]
  RSO["requireSettingsOwner — rejects ?accountId, + offboarding gate, NO writable gate<br/>src/lib/auth/route-helpers.ts:221"]
  ROS["resolveOwnerScope — accountId + cookie locationId + users.id<br/>src/lib/auth/resolve-owner-scope.ts:94"]
  SAMEORIGIN["withSameOrigin — CSRF wrapper on every F3 mutation<br/>src/lib/auth/route-helpers.ts:57"]
end

ROWA --> RR401
RWO --> ROWA
RSO --> ROWA

%% ═══════════════════ LANE A — AUTO-APPROVAL (inv #14) ═══════════════════
subgraph AA["Lane A — Auto-approval policy (invariant 14 - sole server path)"]

  AAPAGE["AutoApprovalSettingsPage — server component<br/>src/app/(authenticated)/settings/auto-approval/page.tsx:11"]
  AACOOKIE["impersonation cookie read<br/>src/app/(authenticated)/settings/auto-approval/page.tsx:16"]
  AASSR["getAutoApprovalSettings — SSR initial state<br/>src/lib/auto-approval/settings.ts:163"]

  AALOAD["loadAutoApprovalSettings — 4 SEQUENTIAL reads, shared executor<br/>src/lib/auto-approval/settings.ts:170"]
  AADEF["loadAccountDefault — location_id IS NULL row<br/>src/lib/auto-approval/settings.ts:952"]
  AALOCS["loadActiveLocationSettings — businesses LEFT JOIN policies<br/>src/lib/auto-approval/settings.ts:989"]
  AAACC["loadSettingsAccount — tier, status, past_due_at, flags<br/>src/lib/auto-approval/settings.ts:1085"]
  AAREADY["buildReadiness — flags + tier + offboarding + writable<br/>src/lib/auto-approval/settings.ts:1098"]
  AAREADYPURE["buildAutoApprovalReadiness — 8 block reasons, canExpand<br/>src/lib/auto-approval/readiness.ts:20"]
  AAFLAGS["auto-approval flags — runtime + provider moderation<br/>src/lib/auto-approval/flags.ts:3"]
  AATIER["tierGrantsAutopilot + autopilotPurchasable<br/>src/lib/auto-approval/settings.ts:1111"]
  AAEFF["resolveEffectivePolicy + resolveDailyCap<br/>src/lib/auto-approval/policy.ts:117"]

  AACLIENT["AutoApprovalClient — useReducer over the SSR payload<br/>src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:113"]
  AALABEL["autoApprovalThresholdLabel — SHARED with F1 admin panel<br/>src/lib/auto-approval/types.ts:31"]
  AACOPY["BLOCK_REASON_COPY — owner register, deliberately NOT shared with F1<br/>src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:37"]
  AAREQ["requestChange — client-side exposure preview<br/>src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:167"]
  AADIAL["requestDialChange — veto/cap, override-creation confirm<br/>src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:197"]
  AACONFIRM["confirmPending — attaches confirmationLevel standard<br/>src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:225"]
  AASEND["sendPatch — PATCH /api/settings/auto-approval<br/>src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:142"]

  AAGET["GET /api/settings/auto-approval<br/>src/app/api/settings/auto-approval/route.ts:21"]
  AAPATCH["patchSettings — impersonation 409, parse, delegate<br/>src/app/api/settings/auto-approval/route.ts:37"]
  AAPARSE["parsePatchBody — AutoApprovalPatchSchema, 10 operations<br/>src/app/api/settings/auto-approval/route.ts:72"]
  AASCHEMA["AutoApprovalPatchSchema — discriminated union, strictObject<br/>src/lib/auto-approval/types.ts:159"]
  AAMETA["requestMetadata — ip, user-agent, request id for audit<br/>src/app/api/settings/auto-approval/route.ts:118"]
  AAERR["autoApprovalErrorResponse — 400 confirm / 409 blocked / coded<br/>src/app/api/settings/auto-approval/route.ts:89"]
  AAEXPORT["export const PATCH = withSameOrigin<br/>src/app/api/settings/auto-approval/route.ts:134"]

  AAPATCHFN["patchAutoApprovalSettings — one sql.begin<br/>src/lib/auto-approval/settings.ts:195"]
  AATX["updatePolicyInTransaction — gate-before-write ordering<br/>src/lib/auto-approval/settings.ts:212"]
  AALOCK["lockAccount — SELECT … FOR UPDATE on accounts<br/>src/lib/auto-approval/settings.ts:381"]
  AAOFF["getOffboardingState + isOperationalUIBlocked — 403<br/>src/lib/auto-approval/settings.ts:217"]
  AABEFORE["readBeforeState — snapshot, scope, archived, affected count<br/>src/lib/auto-approval/settings.ts:397"]
  AAAFTER["computeAfterState — PURE, never re-read from DB<br/>src/lib/auto-approval/settings.ts:454"]
  AAALLOW["assertMutationAllowed — archived, confirm, readiness<br/>src/lib/auto-approval/settings.ts:303"]
  AAARCH["assertArchivedPolicyAllowed — 409 location_inactive<br/>src/lib/auto-approval/settings.ts:250"]
  AACONF["assertConfirmationProvided — 400 confirmation_required<br/>src/lib/auto-approval/settings.ts:267"]
  AAEXP["assertExpansionReady — 409 expansion_blocked<br/>src/lib/auto-approval/settings.ts:283"]
  AACLASS["classifyPolicyExposure — expansion / contraction / no_change<br/>src/lib/auto-approval/policy.ts:90"]
  AAAPPLY["applyMutation — 10 upsert/delete arms, byte-exact ON CONFLICT<br/>src/lib/auto-approval/settings.ts:651"]
  AASUSP["clearsSuspendedRow — never DELETE a governor-suspended row<br/>src/lib/auto-approval/settings.ts:550"]
  AAAUDIT["writeAudit — auto_approval_policy_changed payload<br/>src/lib/auto-approval/settings.ts:331"]
  AALOG["writeAccountAuditLog — same tx, sole audit writer<br/>src/lib/audit/log.ts:24"]
  AATABLE[("auto_approval_policies — server-owned, no browser access<br/>supabase/migrations/074")]
  AAAUDITT[("account_audit_log<br/>src/lib/audit/log.ts:24")]
end

AAPAGE --> ROA
AAPAGE --> AACOOKIE
AAPAGE --> AASSR
AASSR --> AALOAD
AALOAD --> AADEF --> AALOCS --> AAACC --> AAREADY
AAREADY --> AAFLAGS
AAREADY --> AATIER
AAREADY --> AAREADYPURE
AALOCS --> AAEFF
AALOAD --> AACLIENT
AACLIENT --> AALABEL
AACLIENT --> AACOPY
AACLIENT --> AAREQ
AACLIENT --> AADIAL
AAREQ --> AACLASS
AADIAL --> AACLASS
AAREQ --> AASEND
AADIAL --> AASEND
AAREQ --> AACONFIRM --> AASEND
AADIAL --> AACONFIRM
AASEND --> AAEXPORT --> SAMEORIGIN --> AAPATCH
AAPATCH --> RSO
AAPATCH --> AAPARSE --> AASCHEMA
AAPATCH --> AAMETA
AAPATCH --> AAPATCHFN
AAPATCHFN --> AATX
AATX --> AALOCK --> AAOFF --> AABEFORE --> AAAFTER --> AAALLOW
AAALLOW --> AACLASS
AAALLOW --> AAARCH
AAALLOW --> AACONF
AAALLOW --> AAEXP --> AAREADY
AAALLOW --> AAAPPLY
AAAPPLY --> AASUSP
AAAPPLY --> AATABLE
AAAPPLY --> AAAUDIT --> AALOG --> AAAUDITT
AATX --> AALOAD
AAPATCH --> AAERR
AAGET --> RSO
AAGET --> AASSR
AACLIENT --> SHELLUI

%% ═══════════════════ LANE B — BRAND VOICE ═══════════════════
subgraph VOICE["Lane B — Brand voice (per-location)"]
  VPAGE["VoicePage — server component, gate only<br/>src/app/(authenticated)/settings/voice/page.tsx:14"]
  VCLIENT["VoiceClient — location selector + BrandVoicePanel<br/>src/app/(authenticated)/settings/voice/VoiceClient.tsx:22"]
  VHOOK["useLocationVoiceForm — Map of per-location form entries<br/>src/hooks/useLocationVoiceForm.ts:119"]
  VLOADFETCH["mount fetch GET /api/settings/voice<br/>src/hooks/useLocationVoiceForm.ts:141"]
  VMULTI["isMultiLocation — locations.length > 1, CLIENT-side, no flag<br/>src/hooks/useLocationVoiceForm.ts:196"]
  VPATCH["buildPatch — 4-field dirty diff<br/>src/hooks/useLocationVoiceForm.ts:113"]
  VSAVE["save — PUT /api/settings/voice with locationId<br/>src/hooks/useLocationVoiceForm.ts:246"]
  VPANEL["BrandVoicePanel — tone chips, list editors<br/>src/components/dashboard/settings/BrandVoicePanel.tsx:27"]
  VCARD["VoiceReportCard — GET /api/settings/voice/report-card<br/>src/app/(authenticated)/settings/voice/VoiceReportCard.tsx:165"]

  VGET["GET /api/settings/voice — one location or all<br/>src/app/api/settings/voice/route.ts:23"]
  VREPO["getLocationsForAccount — active locations<br/>src/lib/locations/repo.ts:63"]
  VPUT["putVoiceConfig — validate, scope-check, update<br/>src/app/api/settings/voice/route.ts:126"]
  VSCHEMA["VoiceConfigSchema — locationId + at least one field<br/>src/app/api/settings/voice/route.ts:102"]
  VOWNS["location ownership + archived_at check<br/>src/app/api/settings/voice/route.ts:150"]
  VUPD["UPDATE businesses SET dynamic columns<br/>src/app/api/settings/voice/route.ts:178"]
  VEXPORT["export const PUT = withSameOrigin<br/>src/app/api/settings/voice/route.ts:197"]
  BIZ[("businesses — tone, products_services, avoid_facts, sample_responses<br/>src/app/api/settings/voice/route.ts:178")]
end

VPAGE --> ROA
VPAGE --> VCLIENT --> VHOOK
VHOOK --> VLOADFETCH --> VGET
VGET --> ROWA
VGET --> VREPO
VHOOK --> VMULTI
VHOOK --> VPATCH --> VSAVE --> VEXPORT --> SAMEORIGIN --> VPUT
VPUT --> RWO
VPUT --> VSCHEMA --> VOWNS --> VUPD --> BIZ
VCLIENT --> VPANEL
VCLIENT --> VCARD
VCLIENT --> SHELLUI

%% ═══════════ LANE C — SHARED /api/settings READ+WRITE (profile, F4 channels) ═══════════
subgraph SETTINGSAPI["Lane C — shared light settings payload"]
  SHOOK["useSettingsForm — GET on mount, PUT on save<br/>src/hooks/useSettingsForm.ts:94"]
  SPATCH["buildPatch — 7-field dirty diff (voice fields overlap Lane B)<br/>src/hooks/useSettingsForm.ts:45"]
  SREDIR["settingsRedirectForDashboardData — funnel redirect<br/>src/hooks/useSettingsForm.ts:67"]
  SGET["getSettings — businesses JOIN accounts, redirect gates<br/>src/app/api/settings/route.ts:124"]
  SMAP["buildDashboardSettings — row to DashboardSettings DTO<br/>src/lib/dashboard/service-mappers.ts:170"]
  SFUNNEL["resolveFunnelEntry — pending_payment funnel URL (F5, pure)<br/>src/app/api/settings/route.ts:163"]
  SPUT["putSettings — partition fields by table, one tx<br/>src/app/api/settings/route.ts:205"]
  SSCHEMA["UpdateSettingsSchema — 7 optional fields, non-empty<br/>src/app/api/settings/route.ts:21"]
  SUPD["runScopedUpdate — dynamic identifier + column object<br/>src/app/api/settings/route.ts:69"]
  SEXPORT["export const PUT = withSameOrigin<br/>src/app/api/settings/route.ts:293"]
  ACC[("accounts — weekly_summary_enabled, monthly_impact_enabled<br/>src/app/api/settings/route.ts:36")]
end

SHOOK --> SGET
SGET --> RR401
SGET --> SMAP
SGET --> SFUNNEL
SHOOK --> SREDIR
SHOOK --> SPATCH --> SEXPORT --> SAMEORIGIN --> SPUT
SPUT --> RR401
SPUT --> SSCHEMA --> SUPD
SUPD --> BIZ
SUPD --> ACC

%% ═══════════ REMAINING TABS (compact) ═══════════
subgraph TABS["Remaining tabs — compact"]
  direction TB

  PPAGE["ProfilePage — reads cookie-scoped postal address<br/>src/app/(authenticated)/settings/profile/page.tsx:7"]
  PREAD["readPostalAddressState<br/>src/lib/solicitation/postal-address.ts:199"]
  PCLIENT["ProfileClient — SolicitationAddressPanel + ProfilePanel<br/>src/app/(authenticated)/settings/profile/ProfileClient.tsx:19"]
  PADDR["SolicitationAddressPanel — PUT /api/settings/postal-address<br/>src/components/dashboard/settings/SolicitationAddressPanel.tsx:123"]
  PROUTE["putPostalAddress — resolveOwnerScope, NOT requireSettingsOwner<br/>src/app/api/settings/postal-address/route.ts:72"]
  PATTEST["attestPostalAddress — lint, normalize, attest<br/>src/lib/solicitation/postal-address.ts:131"]

  CPAGE["CompetitorsSettingsPage — 2 sequential loads<br/>src/app/(authenticated)/settings/competitors/page.tsx:19"]
  CVIEWS["loadRivalPickerViews — serial loop, deliberate per 773<br/>src/lib/competitors/named-rival.ts:538"]
  CCLIENT["CompetitorsClient — PUT /api/settings/competitors<br/>src/app/(authenticated)/settings/competitors/CompetitorsClient.tsx:37"]
  CROUTE["putRivalPick — parse, delegate, map errors<br/>src/app/api/settings/competitors/route.ts:57"]
  CSET["setNamedRivalPick — guarded UPDATE + analytics enqueue<br/>src/lib/competitors/named-rival.ts:582"]

  LPAGE["LocationsPage — flag gate then loader<br/>src/app/(authenticated)/settings/locations/page.tsx:24"]
  LSHOW["shouldShowLocationsSettings — VISIBILITY (flag only)<br/>src/lib/locations/multi-location-mode.ts:15"]
  LADD["resolveAddLocationState to canAddLocationForAccount — ELIGIBILITY<br/>src/lib/locations/multi-location-mode.ts:38"]
  LMODE["shouldUseMultiLocationSettings — MODE, consumed by F4 only<br/>src/lib/locations/multi-location-mode.ts:8"]
  LVIEW["loadLocationsSettingsView — 6 sequential reads, no Promise.all<br/>src/lib/locations/settings-view.ts:57"]
  LPANEL["LocationsPanel — promote-primary, display-label<br/>src/components/dashboard/settings/LocationsPanel.tsx:364"]
  LOWNER["readOwnerForMultiLocationRoute — flag + CSRF + writable<br/>src/lib/locations/owner-route.ts:26"]
  LAPI["POST /api/locations/{add,archive,reactivate,promote-primary}<br/>src/app/api/locations/add/route.ts:87"]
  LQUOTA["assertCanAddLocation — quota chokepoint<br/>src/app/api/locations/add/route.ts:112"]

  BPAGE["BillingPage — gate only<br/>src/app/(authenticated)/settings/billing/page.tsx:6"]
  BHOOK["useAccountData — GET /api/account/settings<br/>src/hooks/useAccountData.ts:45"]
  BROUTE["GET /api/account/settings — quota + billing + plan<br/>src/app/api/account/settings/route.ts:27"]
  BSNAP["currentBillingSnapshot — STORED accounts columns (inv 9a)<br/>src/lib/accounts/quota.ts:56"]
  BPANEL["BillingPanel — portal + tier-change + cancel<br/>src/components/dashboard/settings/BillingPanel.tsx:292"]
  BCANCEL["CancelSubscriptionPanel — offboarding confirm/reactivate<br/>src/components/dashboard/settings/CancelSubscriptionPanel.tsx:59"]

  SECPAGE["SettingsSecurityPage — gate only<br/>src/app/(authenticated)/settings/security/page.tsx:7"]
  SECCLIENT["SecurityClient — TOTP enrollment UI<br/>src/app/(authenticated)/settings/security/SecurityClient.tsx:8"]
  SECMFA["useMfaEnrollment — supabase.auth.mfa + /api/auth/mfa/challenge<br/>src/components/auth/useMfaEnrollment.ts:148"]
end

PPAGE --> ROA
PPAGE --> PREAD
PPAGE --> PCLIENT --> SHOOK
PCLIENT --> PADDR --> PROUTE --> ROS
PROUTE --> PATTEST

CPAGE --> ROA
CPAGE --> CVIEWS
CPAGE --> CCLIENT --> CROUTE --> RSO
CROUTE --> CSET --> BIZ

LPAGE --> LSHOW
LPAGE --> ROA
LPAGE --> LVIEW
LPAGE --> LADD
LPANEL --> LAPI --> LOWNER
LAPI --> LQUOTA
LVIEW --> LPANEL

BPAGE --> ROA
BPAGE --> BHOOK --> BROUTE --> ROWA
BROUTE --> BSNAP
BHOOK --> BPANEL --> BCANCEL

SECPAGE --> ROA
SECPAGE --> SECCLIENT --> SECMFA

%% ═══════════ EXTERNAL ═══════════
subgraph EXT["External dependencies — referenced, not charted"]
  F4CH["settings/channels — F4 charts it (reads F4 flag/env/override modules)<br/>src/app/(authenticated)/settings/channels/page.tsx:23"]
  F4TAB["ChannelsTabClient — consumes F3's useSettingsForm + PUT /api/settings<br/>src/app/(authenticated)/settings/channels/ChannelsTabClient.tsx:42"]
  F6BILL["POST /api/billing/portal + /api/billing/tier-change — F6<br/>src/components/dashboard/settings/BillingPanel.tsx:228"]
  OFFB["/api/account/offboarding/* — owner offboarding<br/>src/components/dashboard/settings/CancelSubscriptionPanel.tsx:89"]
  MFAAPI["/api/auth/mfa/challenge — MFA ceremony owner<br/>src/components/auth/useMfaEnrollment.ts:191"]
  GOV["Governor writes suspended_at on auto_approval_policies<br/>src/lib/auto-approval/types.ts:119"]
  ADMINF1["F1 admin diagnostics reuses autoApprovalThresholdLabel only<br/>src/lib/auto-approval/types.ts:31"]
  CIPOL["ci:static-policy — bans auto_approval_policies in client files<br/>scripts/ci/static-policy-audit.ts:139"]
end

SIDEBAR --> F4CH
F4TAB --> SHOOK
BPANEL --> F6BILL
BCANCEL --> OFFB
SECMFA --> MFAAPI
AATABLE --> GOV
AALABEL --> ADMINF1
AATABLE --> CIPOL
```

---

## Happy-path walk

### Shell

`SettingsLayout` (`src/app/(authenticated)/settings/layout.tsx:5`) is a pure
two-column frame: a client `SettingsSidebar`
(`src/components/dashboard/settings/SettingsSidebar.tsx:47`) with eight tabs in
two groups, plus a `settings-detail` slot for the active tab. The bare
`/settings` index redirects to `/settings/voice`
(`src/app/(authenticated)/settings/page.tsx:3`), and the sidebar mirrors that
default in `resolveActiveHref`
(`src/components/dashboard/settings/SettingsSidebar.tsx:41`). The layout holds no
data and does no auth — **each tab page gates itself** with `requireOwnerAccess`
(`src/lib/auth/require-owner-access.ts:42`), which resolves the account from the
Supabase session and the current location from the `rw_location_scope` cookie,
redirecting admins to `/admin/overview` and non-entitled owners to
`/onboarding/pay`. A segment error boundary
(`src/app/(authenticated)/settings/error.tsx:5`) catches any tab's server throw.

### READ lane — auto-approval settings load

1. `AutoApprovalSettingsPage`
   (`src/app/(authenticated)/settings/auto-approval/page.tsx:11`) runs
   `requireOwnerAccess` and `cookies()` in one `Promise.all`, then reads the
   impersonation cookie (`:16`) and calls `getAutoApprovalSettings`
   (`src/lib/auto-approval/settings.ts:163`) with the singleton `sql` — the page
   is the composition root; the domain module takes `db` as a parameter
   (invariant #15).
2. `loadAutoApprovalSettings` (`src/lib/auto-approval/settings.ts:170`) runs
   **four reads strictly sequentially** — `loadAccountDefault` (`:952`),
   `loadActiveLocationSettings` (`:989`), `loadSettingsAccount` (`:1085`),
   `buildReadiness` (`:1098`). The sequencing is annotated in-code at `:181-182`
   as deliberate #773 behaviour, not an oversight.
3. `loadActiveLocationSettings` resolves each location's effective policy through
   `resolveEffectivePolicy` / `resolveDailyCap`
   (`src/lib/auto-approval/policy.ts:117`, `:31`) so inheritance is computed
   once, server-side.
4. `buildReadiness` composes runtime flags (`src/lib/auto-approval/flags.ts:3`),
   `tierGrantsAutopilot` + `autopilotPurchasable`
   (`src/lib/auto-approval/settings.ts:1111`), the offboarding gate, and the
   writable-subscription check into the pure
   `buildAutoApprovalReadiness` (`src/lib/auto-approval/readiness.ts:20`), which
   emits `canExpand` plus up to eight `blockReasons`.
5. The payload is passed as `initialState` to `AutoApprovalClient`
   (`src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:113`).
   The client renders labels through the **shared**
   `autoApprovalThresholdLabel` (`src/lib/auto-approval/types.ts:31`) and block
   reasons through its **own** `BLOCK_REASON_COPY`
   (`AutoApprovalClient.tsx:37`) — the deliberate split recorded in
   `00-features.md`.

`GET /api/settings/auto-approval`
(`src/app/api/settings/auto-approval/route.ts:21`) exists for client refresh and
calls the same `getAutoApprovalSettings`; there is exactly one loader.

### WRITE lane — a policy update

1. The owner changes a threshold or a dial. `requestChange`
   (`AutoApprovalClient.tsx:167`) or `requestDialChange` (`:197`) classifies the
   change client-side with `classifyPolicyExposure`
   (`src/lib/auto-approval/policy.ts:90`) — the **same pure function the server
   uses**. Non-expansions submit immediately; expansions (and dial changes that
   would create a location override) open a confirmation modal, and
   `confirmPending` (`:225`) resubmits with `confirmationLevel: 'standard'`.
2. `sendPatch` (`:142`) `PATCH`es `/api/settings/auto-approval`. The route export
   is wrapped in `withSameOrigin()` (`route.ts:134`).
3. `patchSettings` (`route.ts:37`) gates with `requireSettingsOwner`
   (`src/lib/auth/route-helpers.ts:221` — rejects `?accountId`, requires an
   owner + account, applies the operational-UI offboarding gate, deliberately
   *not* the writable-subscription gate), 409s any impersonated session (`:41`),
   parses against `AutoApprovalPatchSchema`
   (`src/lib/auto-approval/types.ts:159` — a 10-arm discriminated union of
   `strictObject`s), and collects ip/user-agent/request-id for the audit row
   (`route.ts:118`).
4. `patchAutoApprovalSettings` (`src/lib/auto-approval/settings.ts:195`) opens
   ONE `sql.begin`. Inside, `updatePolicyInTransaction` (`:212`) runs a strict
   **gate-before-write** order: `lockAccount` `SELECT … FOR UPDATE` (`:381`) →
   offboarding block (`:217`) → `readBeforeState` (`:397`) → the **pure**
   `computeAfterState` (`:454`) → `assertMutationAllowed` (`:303`) →
   `applyMutation` (`:651`) → `writeAudit` (`:331`).
5. `assertMutationAllowed` runs three gates in fixed order:
   `assertArchivedPolicyAllowed` (`:250`, 409 `location_inactive`),
   `assertConfirmationProvided` (`:267`, 400 `auto_approval_confirmation_required`),
   `assertExpansionReady` (`:283`, 409 `auto_approval_expansion_blocked`). Any
   throw happens before a single write, so "blocked ⇒ nothing written" is
   structural rather than a rollback side effect.
6. `applyMutation` runs one of ten upsert/delete arms whose `ON CONFLICT`
   predicates match migration 074's partial unique indexes byte-for-byte, and
   consults `clearsSuspendedRow` (`:550`) so a clear/delete on a
   governor-suspended row degrades to a threshold-`NULL` update rather than
   laundering the suspension.
7. `writeAudit` → `writeAccountAuditLog` (`src/lib/audit/log.ts:24`) in the same
   transaction, then the transaction re-runs `loadAutoApprovalSettings` on `tx`
   (`:205`) so the response is the post-write state read inside the same
   transaction — the client swaps its whole reducer state for it
   (`AutoApprovalClient.tsx:158`).

### WRITE lane — brand voice

`VoicePage` (`src/app/(authenticated)/settings/voice/page.tsx:14`) only gates;
all data arrives client-side. `useLocationVoiceForm`
(`src/hooks/useLocationVoiceForm.ts:119`) fetches `GET /api/settings/voice`
(`src/app/api/settings/voice/route.ts:23`, gated by `requireOwnerWithAccount`)
once on mount, builds a `Map` of per-location form entries, and defaults the
selection to the primary location. On save, `buildPatch` (`:113`) diffs the four
voice fields and `save` (`:246`) `PUT`s `{ locationId, ...patch }`.
`putVoiceConfig` (`route.ts:126`) gates with `requireWritableOwner`
(`src/lib/auth/route-helpers.ts:187`), validates against `VoiceConfigSchema`
(`route.ts:102`), re-checks the location's account ownership and `archived_at`
(`route.ts:150`), and runs one dynamic `UPDATE businesses` (`route.ts:178`). No
transaction — a single statement.

---

## Side effects

**Tables written**

| Table | Writer | Path |
|---|---|---|
| `auto_approval_policies` | `applyMutation` | `src/lib/auto-approval/settings.ts:651` (10 arms, `:673`/`:683`/`:706`/`:716` for the clear/delete shapes) |
| `account_audit_log` | `writeAccountAuditLog` | `src/lib/auto-approval/settings.ts:338` → `src/lib/audit/log.ts:24` (event `auto_approval_policy_changed`); also the locations lifecycle (`src/app/api/locations/add/route.ts:81`) and §7.6 owner clearing |
| `businesses` (voice/contact) | `putVoiceConfig` | `src/app/api/settings/voice/route.ts:178` |
| `businesses` (voice/contact, cookie-scoped) | `runScopedUpdate` | `src/app/api/settings/route.ts:69` + `:255` |
| `businesses.rival_place_id` | `setNamedRivalPick` | `src/lib/competitors/named-rival.ts:582` (guarded single `UPDATE … WHERE` inside a tx) |
| `businesses` postal-address columns | `attestPostalAddress` | `src/lib/solicitation/postal-address.ts:131` |
| `accounts` (digest toggles) | `runScopedUpdate` | `src/app/api/settings/route.ts:36` + `:271` |
| `businesses` (insert/archive/reactivate/promote) | locations transactions | `src/app/api/locations/add/route.ts:87`, `archive/route.ts:58`, `reactivate/route.ts:53`, `promote-primary/route.ts:47` |

**Outbox enqueues** — none on the auto-approval or voice lanes. The locations tab
is the only F3 surface that enqueues: `update_stripe_overage_quantity` on add
(`src/app/api/locations/add/route.ts:82`), the decrement on archive
(`src/app/api/locations/archive/route.ts:53`), and increment +
`zernio_initial_backfill` on reactivate
(`src/app/api/locations/reactivate/route.ts:47-48`) — each in the same
transaction as its `businesses` write (invariant #2).

**Analytics** — `setNamedRivalPick` enqueues a durable analytics event inside its
transaction (`src/lib/competitors/named-rival.ts:598`).

**Cache invalidation** — none. Every F3 page is `export const dynamic =
'force-dynamic'` (e.g. `auto-approval/page.tsx:9`, `voice/page.tsx:12`,
`competitors/page.tsx:17`, `locations/page.tsx:22`) and every route sets
`no-store` through `jsonResponse`. No `revalidatePath`/`revalidateTag` anywhere
in F3; the auto-approval client refreshes purely from the PATCH response.

**External calls** — none from F3 itself. Stripe is reached only indirectly, via
the outbox (locations) or by handing off to F6's `/api/billing/*`
(`src/components/dashboard/settings/BillingPanel.tsx:228`, `:312`). MFA
enrollment calls Supabase Auth from the browser and `/api/auth/mfa/challenge`
for the gated steps (`src/components/auth/useMfaEnrollment.ts:148`, `:191`).

**Locks / concurrency** — one: `lockAccount`'s `SELECT … FOR UPDATE`
(`src/lib/auto-approval/settings.ts:381`), correctly inside `sql.begin` so
PgBouncer transaction pooling preserves it.

---

## Invariant checks

**#14 — auto-approval policy access is server-owned.** Enforced by three
independent things: (a) exactly one route touches the table's domain module —
`src/app/api/settings/auto-approval/route.ts:21`/`:37`; (b)
`src/lib/auto-approval/settings.ts` is the only module issuing SQL against
`auto_approval_policies` (reads `:952`/`:970`/`:989`/`:1065`, writes `:651`);
(c) `ci:static-policy` bans the literal table name in any `'use client'` file
(`scripts/ci/static-policy-audit.ts:139-148`). The client receives only the
`AutoApprovalSettingsResponse` DTO (`src/lib/auto-approval/types.ts:139`) and
sends only schema-validated operations. The audit's own comment (`:136-138`)
notes it is file-local and does not follow imports — code review remains the
backstop.

**#13 — flags are server-authoritative.** `autoApprovalRuntimeEnabled`,
`providerModerationEnabled`, `providerModerationValidated`
(`src/lib/auto-approval/flags.ts:3`, `:11`, `:15`) and `multiLocationEnabled`
(`src/lib/locations/flags.ts:15`) are read only in server components / route
handlers; the browser learns state as `blockReasons` and `addLocationState`. No
`NEXT_PUBLIC_*` companion exists.

**#9b — three distinct multi-location checks.** They remain three functions in
`src/lib/locations/multi-location-mode.ts` and are *not* collapsed:
`shouldShowLocationsSettings` (visibility) at `:15`, used by
`src/app/(authenticated)/settings/locations/page.tsx:26`;
`canAddLocationForAccount` (eligibility) at `:19`, reached only through
`resolveAddLocationState` (`:38`) from `locations/page.tsx:39`;
`shouldUseMultiLocationSettings` (mode) at `:8`, consumed today **only outside
F3** — `src/app/(authenticated)/settings/channels/page.tsx:51` and
`src/lib/channels/override.ts:83`. See finding F3-4 for the client-side mode
derivation that bypasses it.

**#9a — billing reads stored, not live.** `currentBillingSnapshot`
(`src/lib/accounts/quota.ts:56`) selects `locations_included`,
`locations_overage_price_cents` and `base_price_cents` off `accounts` with an
explicit in-code note at `:85-88`. `GET /api/account/settings`
(`src/app/api/account/settings/route.ts:27`) surfaces those plus the stored
`locations_paid`. This is a second read model against the same Stripe
subscription F6 reads through the Checkout attempt snapshot — recorded as
DO-NOT-UNIFY in `00-features.md`, and correct as charted.

**#773 sequencing.** Deliberately sequential and annotated: the auto-approval
loader (`src/lib/auto-approval/settings.ts:181-182`), the competitors loop
(`src/lib/competitors/named-rival.ts:544`), the locations loader
(`src/lib/locations/settings-view.ts:37`, `:61-63`). Deliberately parallel and
annotated as fixed-width: `GET /api/account/settings`'s width-2 read
(`src/app/api/account/settings/route.ts:70-76`) and `POST /api/locations/add`'s
width-3 pre-transaction gather (`src/app/api/locations/add/route.ts:124-131`),
both citing spec §3.6. `auto-approval/page.tsx:12` also runs a width-2
`Promise.all`, but only one arm touches the DB.

---

## Findings — duplicated / near-duplicated / structurally odd

**F3-1 — two write paths to the same four `businesses` voice columns, with
different auth gates.** `PUT /api/settings`
(`src/app/api/settings/route.ts:205`) writes `tone`, `products_services`,
`avoid_facts`, `sample_responses` for the **session-scoped** location via
`runScopedUpdate` (`:69`), gated by `requireRoleOr401` + an inline
`assertWritableSubscriptionForAccount` (`:225`). `PUT /api/settings/voice`
(`src/app/api/settings/voice/route.ts:126`) writes the **same four columns** for
a **body-supplied** `locationId`, gated by `requireWritableOwner`
(`route-helpers.ts:187`), with its own near-identical dynamic-column update
(`route.ts:172-184`) whose comment explicitly says it "mirrors runScopedUpdate".
The column maps are duplicated (`route.ts:42-48` vs `voice/route.ts:117-122`)
and the zod field definitions are duplicated verbatim
(`route.ts:23-26` vs `voice/route.ts:105-108`).

**F3-2 — `buildPatch` exists twice.** `src/hooks/useSettingsForm.ts:45` (7
fields) and `src/hooks/useLocationVoiceForm.ts:113` (4 fields, a strict subset)
implement the same dirty-diff idiom, including the identical
`JSON.stringify`-compare + `flatMap` trim for `avoidFacts`/`sampleResponses`
(`useSettingsForm.ts:49-60` vs `useLocationVoiceForm.ts:95-108`). `dirtyCount`
is also spelled twice (`useSettingsForm.ts:152` vs
`useLocationVoiceForm.ts:205`).

**F3-3 — five different owner gates across eight F3 write surfaces.**
`requireRoleOr401` (`src/app/api/settings/route.ts:206`), `requireWritableOwner`
(`src/app/api/settings/voice/route.ts:127`, `locations/display-label/route.ts:27`),
`requireSettingsOwner` (`auto-approval/route.ts:38`, `competitors/route.ts:57`),
`resolveOwnerScope` (`postal-address/route.ts:75`), and
`readOwnerForMultiLocationRoute` (`src/lib/locations/owner-route.ts:26`). Each
divergence is documented in-code with a reason —
`requireSettingsOwner`'s doc comment (`route-helpers.ts:204-220`) and the
postal-address header (`postal-address/route.ts:10-35`) are unusually explicit —
so this is *reasoned* rather than accidental. It is still five gate shapes on one
tab rail, and only one of them (`requireSettingsOwner`) rejects `?accountId`.

**F3-4 — the multi-location "mode" check is re-derived client-side without the
flag.** `src/hooks/useLocationVoiceForm.ts:196` computes
`const isMultiLocation = locations.length > 1`, driving the Voice tab's location
selector (`VoiceClient.tsx:62`). That is the semantic of
`shouldUseMultiLocationSettings` (`multi-location-mode.ts:8`) minus its
`featureEnabled` term. Benign today (the selector is presentation only, and the
server list is already account-scoped), but it is the exact collapse invariant
#9b forbids, one hop from a behavioural check.

**F3-5 — F4's channels tab writes through F3's route.** `ChannelsTabClient`
(`src/app/(authenticated)/settings/channels/ChannelsTabClient.tsx:42`) uses
`useSettingsForm`, i.e. `GET`/`PUT /api/settings`, to persist `ownerPhone` and
the digest toggles. So a route the boundary assigns to F3 has an F4 consumer,
and F3's `runScopedUpdate` writes `accounts.weekly_summary_enabled` /
`monthly_impact_enabled` — notification settings — on F4's behalf. Not
duplication; a cross-boundary coupling both charts must agree on.

**F3-6 — one route, two contradictory `no-store` idioms.** `/api/settings/**`
returns through `jsonResponse` (`route-helpers.ts:96`), while
`/api/locations/**` hand-rolls `LOCATION_ROUTE_NO_STORE`
(`src/lib/locations/owner-route.ts:13`) and calls `NextResponse.json` directly
(`src/app/api/locations/add/route.ts:104`, `:117`, `:134`). Cosmetic, but it is
why the locations routes also re-spell their own error-response helpers
(`owner-route.ts:154-182`).

**F3-7 — the `/settings` index redirect is spelled twice.**
`src/app/(authenticated)/settings/page.tsx:4` redirects to `/settings/voice`, and
`SettingsSidebar.resolveActiveHref`
(`src/components/dashboard/settings/SettingsSidebar.tsx:42`) independently
hardcodes the same default so the nav highlights correctly during the redirect.
Two owners of one default; the comment at `:40` acknowledges it.

---

## External dependencies

| Dependency | Where F3 touches it | Owner |
|---|---|---|
| `settings/channels` tab | listed in `SettingsSidebar.tsx:23`; its page reads F4 flag/env/override modules directly (`settings/channels/page.tsx:20-26`) | **F4** — do not redraw |
| `ChannelsTabClient` → `useSettingsForm` | `settings/channels/ChannelsTabClient.tsx:42` → `src/hooks/useSettingsForm.ts:94` | F4 consumer of an F3 route |
| `src/lib/channels/overrides-view.ts` | consumed only by the channels page + `/api/settings/channels/overrides` | **F4** |
| `src/lib/auth/**` | `requireOwnerAccess:42`, `requireRoleOr401:140`, `requireOwnerWithAccount:167`, `requireWritableOwner:187`, `requireSettingsOwner:221`, `resolveOwnerScope`, `withSameOrigin:57` | **S1 seam** |
| `/api/billing/portal`, `/api/billing/tier-change` | `BillingPanel.tsx:228`, `:312`, `:340` | **F6** |
| `/api/account/offboarding/*` | `CancelSubscriptionPanel.tsx:89`, `:115`; `DeleteDataOffboardingModal.tsx:54`, `:64` | owner offboarding |
| `/api/auth/mfa/challenge` + Supabase MFA | `useMfaEnrollment.ts:148`, `:191`, `:205`, `:236` | auth/MFA |
| `resolveFunnelEntry` | `src/app/api/settings/route.ts:163` (pending-payment redirect) | **F5** (pure, flag passed in) |
| `autoApprovalThresholdLabel` | `src/lib/auto-approval/types.ts:31` — shared with F1's admin diagnostics panel | shared by design (#827) |
| Governor `suspended_at` writer | writes the column F3 only reads (`types.ts:119`); F3 never clears it (`settings.ts:550`) | WS6 governor |
| `assertCanAddLocation` quota chokepoint | `src/app/api/locations/add/route.ts:112` | accounts/quota |
| `attestPostalAddress` / `readPostalAddressState` | `src/lib/solicitation/postal-address.ts:131`, `:199` | solicitation |
| `setNamedRivalPick` analytics enqueue | `src/lib/competitors/named-rival.ts:598` | analytics |
| `ci:static-policy` | `scripts/ci/static-policy-audit.ts:139-148` — the CI half of invariant #14 | CI |

---

## Confidence & coverage

**High confidence** on: the shell, both auto-approval lanes (route + module read
end to end), both voice lanes, `/api/settings` GET+PUT, the multi-location check
topology, and the billing read model.

**Medium confidence** on the compact tabs: I read every entry point and every
route/module signature but did not read `LocationsClient.tsx`,
`CompetitorsClient.tsx`, `SecurityClient.tsx`, `ProfilePanel.tsx`,
`ListEditor.tsx`, `ToneChipPicker.tsx` or `SettingsModal.tsx` in full — their
presentation detail is summarized, not traced.

**Not read:** the bodies of `addLocationTransaction`,
`archive-location-tx`, `promote-primary-tx`, `attestPostalAddress`,
`loadRivalPickerView`, `buildDashboardSettings`, `buildPlanPresentation`; any
`__tests__` file; every `settings/channels` file (out of scope by boundary rule).
