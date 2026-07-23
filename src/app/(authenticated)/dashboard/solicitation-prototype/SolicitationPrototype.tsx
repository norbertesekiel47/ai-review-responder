'use client';

// PROTOTYPE — ticket #537 (wayfinder map #528). Throwaway. Mock data only:
// no fetching, no mutations, no persistence. The six withhold reason codes
// are rendered VERBATIM from the #533 restraint-policy enum
// (docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md §1).
//
// Plan: three variants of the watch-mode batch screen on this one route,
// switchable via ?variant=A|B|C (floating bottom bar, arrow keys work);
// ?state=empty flips every variant to its pre-CSV-upload empty state.

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import './prototype.css';

/* ------------------------------------------------------------------ */
/* Mock data — one watch-mode batch for a personal_care business.      */
/* 48 rows uploaded → 2 rejected at upload (ingest hygiene, NOT a      */
/* withhold — #533 boundary rule) → 46 valid candidates → 17 withheld  */
/* by per-candidate gates → 29 eligible → cap 25 → 25 queued,          */
/* 4 velocity_banked.                                                  */
/* ------------------------------------------------------------------ */

type WithholdReason =
  | 'no_consent'
  | 'suppressed'
  | 'already_reviewed'
  | 'stale_visit'
  | 'over_contacted'
  | 'velocity_banked';

type Outcome = 'queued' | WithholdReason;

interface Candidate {
  id: string;
  name: string;
  handle: string;
  lastVisit: string;
  daysSince: number;
  outcome: Outcome;
  evidence?: string;
}

// Precedence order is part of the #533 contract: first-match wins.
const REASON_ORDER: WithholdReason[] = [
  'no_consent',
  'suppressed',
  'already_reviewed',
  'stale_visit',
  'over_contacted',
  'velocity_banked',
];

const REASON_META: Record<
  WithholdReason,
  { label: string; gate: string; tone: 'hold' | 'bank' }
> = {
  no_consent: {
    label: 'Not covered by your consent attestation',
    gate: 'Consent check',
    tone: 'hold',
  },
  suppressed: {
    label: 'Marked never-contact',
    gate: 'Suppression list',
    tone: 'hold',
  },
  already_reviewed: {
    label: 'Already left a review',
    gate: 'Review match',
    tone: 'hold',
  },
  stale_visit: {
    label: 'Visit is too old to ask about',
    gate: 'Freshness window',
    tone: 'hold',
  },
  over_contacted: {
    label: 'Asked too recently',
    gate: 'Contact frequency',
    tone: 'hold',
  },
  velocity_banked: {
    label: 'Saved for the next batch',
    gate: 'Batch cap',
    tone: 'bank',
  },
};

const MOCK_TODAY = new Date('2026-07-23T12:00:00Z');

function visitDate(daysSince: number): string {
  const d = new Date(MOCK_TODAY.getTime() - daysSince * 86_400_000);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const NAMES = [
  'Maya Delgado', 'Jonas Petersen', 'Aisha Okafor', 'Tom Reilly', 'Priya Nair',
  'Sam Kowalski', 'Elena Vasquez', 'Marcus Webb', 'Ingrid Larsen', 'Dev Patel',
  'Rosa Camacho', 'Ben Whitfield', 'Lucia Ferraro', 'Nate Brooks', 'Hana Suzuki',
  'Omar Haddad', 'Grace Lindqvist', 'Theo Marchand', 'Nia Thompson', 'Felix Braun',
  'Carmen Ruiz', 'Jack Donnelly', 'Amara Diallo', 'Leo Santos', 'Petra Novak',
  'Ava Sinclair', 'Ruben Ortiz', 'Kiara Bennett', 'Oscar Lindgren',
  'Tessa Malone', 'Yusuf Demir', 'Colin Hayes',
  'Dana Whitmore',
  'Iris Kavanagh', 'Paulo Mendes', 'Sofia Anders', 'Gil Harmon',
  'Rhea Kapoor', 'Milo Sørensen', 'June Albright', 'Casper Doyle', 'Vera Molnar', 'Ezra Whitaker',
  'Noor Rahmani', 'Silas Ford', 'Bea Castellano',
] as const;

const HANDLES = [
  'm•••@gmail.com', '(415) ••• 2214', 'j•••@outlook.com', '(628) ••• 8802',
  'p•••@icloud.com', '(415) ••• 4471', 'e•••@gmail.com', '(510) ••• 1937',
];

function handleFor(index: number): string {
  return HANDLES[index % HANDLES.length] as string;
}

function buildBatch(): Candidate[] {
  const rows: Candidate[] = [];
  const push = (
    index: number,
    outcome: Outcome,
    daysSince: number,
    evidence?: string,
  ) => {
    rows.push({
      id: `cand-${index + 1}`,
      name: NAMES[index] as string,
      handle: handleFor(index),
      lastVisit: visitDate(daysSince),
      daysSince,
      outcome,
      evidence,
    });
  };

  // 25 queued — freshest visits kept (banking is most-recent-first).
  for (let i = 0; i < 25; i++) push(i, 'queued', (i % 13) + 1);

  // 4 velocity_banked — passed every gate; least-fresh of the 29 eligible.
  for (let i = 25; i < 29; i++) {
    push(
      i, 'velocity_banked', 14 + (i - 25),
      'Passed every gate · batch cap of 25 reached (29 eligible) · first in line for the next batch',
    );
  }

  // 3 no_consent
  for (let i = 29; i < 32; i++) {
    push(i, 'no_consent', (i % 9) + 2,
      'Row not covered by this upload’s consent attestation');
  }

  // 1 suppressed
  push(32, 'suppressed', 6, 'Marked never-contact by you on Jul 2');

  // 4 already_reviewed — review date only, never the rating (sentiment-blind).
  const reviewDays = [12, 19, 33, 41];
  for (let i = 33; i < 37; i++) {
    const reviewedDaysAgo = reviewDays[i - 33] as number;
    push(i, 'already_reviewed', reviewedDaysAgo + 2,
      `Matched to a review from ${visitDate(reviewedDaysAgo)} · rating not shown, by design`);
  }

  // 6 stale_visit — personal_care window is 21 days.
  const staleDays = [24, 30, 37, 45, 52, 60];
  for (let i = 37; i < 43; i++) {
    const days = staleDays[i - 37] as number;
    push(i, 'stale_visit', days,
      `Visited ${days} days ago · over the 21-day window for personal_care (matched “salon”)`);
  }

  // 3 over_contacted
  for (let i = 43; i < 46; i++) {
    push(i, 'over_contacted', (i % 7) + 3,
      'Was in the would-have-sent set of the Jul 8 batch · 30-day minimum gap');
  }

  return rows;
}

const BATCH = buildBatch();
const QUEUED = BATCH.filter((c) => c.outcome === 'queued');
const WITHHELD = BATCH.filter(
  (c) => c.outcome !== 'queued' && c.outcome !== 'velocity_banked',
);
const BANKED = BATCH.filter((c) => c.outcome === 'velocity_banked');
const byReason = (reason: WithholdReason) =>
  BATCH.filter((c) => c.outcome === reason);

/* ------------------------------------------------------------------ */
/* Shared atoms (chips + banner only — layout is per-variant)          */
/* ------------------------------------------------------------------ */

function ReasonChip({ reason }: { reason: WithholdReason }) {
  return (
    <span className={`sp-chip sp-chip--${REASON_META[reason].tone}`}>
      {reason}
    </span>
  );
}

function WatchModeBanner() {
  return (
    <div className="sp-watch-banner">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"
          stroke="currentColor" strokeWidth="1.6"
        />
        <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      </svg>
      <span>
        <strong>Watch-mode.</strong> RepWorth planned this batch but sent
        nothing. This is what it would have done, and why.
      </span>
    </div>
  );
}

function IngestFootnote() {
  return (
    <p className="sp-ingest-note">
      2 rows in your upload failed validation (bad phone format) and never
      reached these checks — see the upload report.
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Variant A — “Ledger”: two panels, send left, spoilage report right  */
/* ------------------------------------------------------------------ */

function VariantLedger() {
  return (
    <>
      <WatchModeBanner />
      <div className="sp-ledger">
        <section className="sp-bezel">
          <div className="sp-core">
            <header className="sp-panel-head">
              <h2>Would have sent</h2>
              <span className="sp-count sp-count--send">{QUEUED.length}</span>
            </header>
            <ul className="sp-rowlist">
              {QUEUED.map((c) => (
                <li key={c.id} className="sp-row">
                  <div>
                    <div className="sp-row-name">{c.name}</div>
                    <div className="sp-row-sub">
                      {c.handle} · visited {c.lastVisit}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="sp-bezel">
          <div className="sp-core">
            <header className="sp-panel-head">
              <h2>Held back</h2>
              <span className="sp-count sp-count--hold">
                {WITHHELD.length + BANKED.length}
              </span>
            </header>
            <p className="sp-panel-sub">
              Every hold has exactly one reason, checked in a fixed order.
            </p>
            {REASON_ORDER.map((reason) => {
              const group = byReason(reason);
              if (group.length === 0 && reason !== 'suppressed') return null;
              return (
                <div key={reason} className="sp-group">
                  <div className="sp-group-head">
                    <ReasonChip reason={reason} />
                    <span className="sp-group-label">
                      {REASON_META[reason].label}
                    </span>
                    <span className="sp-group-count">{group.length}</span>
                  </div>
                  {group.length === 0 ? (
                    <p className="sp-row-sub sp-group-empty">
                      Nobody this batch.
                    </p>
                  ) : (
                    <ul className="sp-rowlist">
                      {group.map((c) => (
                        <li key={c.id} className="sp-row">
                          <div>
                            <div className="sp-row-name">{c.name}</div>
                            <div className="sp-row-sub">{c.evidence}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
      <IngestFootnote />
    </>
  );
}

function LedgerEmpty() {
  return (
    <div className="sp-empty-center">
      <div className="sp-bezel sp-empty-card">
        <div className="sp-core">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="sp-empty-icon">
            <path d="M12 16V4m0 0-4 4m4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <h2 className="sp-empty-title">No contact list yet</h2>
          <p className="sp-empty-copy">
            Upload a CSV of recent customers and attest that they consented to
            be contacted. RepWorth will plan a batch of review requests, and in
            watch-mode it sends nothing: you see exactly who it would ask and
            who it would hold back, with the reason for every hold.
          </p>
          <div className="sp-empty-actions">
            <button type="button" className="sp-btn-primary">
              Upload contacts CSV
            </button>
            <button type="button" className="sp-btn-ghost">
              Download the template
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Variant B — “Pipeline”: precedence funnel, gates expandable         */
/* ------------------------------------------------------------------ */

function VariantPipeline() {
  return (
    <>
      <div className="sp-bezel">
        <div className="sp-core sp-pipe-hero">
          <div className="sp-pipe-stat">
            <span className="sp-pipe-num">48</span>
            <span className="sp-pipe-cap">rows uploaded</span>
          </div>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div className="sp-pipe-stat">
            <span className="sp-pipe-num">46</span>
            <span className="sp-pipe-cap">valid candidates</span>
          </div>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div className="sp-pipe-stat">
            <span className="sp-pipe-num sp-pipe-num--send">{QUEUED.length}</span>
            <span className="sp-pipe-cap">would have been sent</span>
          </div>
          <span className="sp-watch-pill">
            watch-mode · nothing sent
          </span>
        </div>
      </div>

      <div className="sp-pipe-rail">
        {REASON_ORDER.map((reason, index) => {
          const group = byReason(reason);
          return (
            <details key={reason} className="sp-stage" open={reason === 'stale_visit'}>
              <summary className="sp-stage-head">
                <span className="sp-stage-step">{index + 1}</span>
                <span className="sp-stage-gate">{REASON_META[reason].gate}</span>
                <ReasonChip reason={reason} />
                <span className="sp-stage-count">
                  {group.length === 0
                    ? 'held nobody'
                    : `held ${group.length}`}
                </span>
              </summary>
              {group.length > 0 && (
                <ul className="sp-rowlist sp-stage-body">
                  {group.map((c) => (
                    <li key={c.id} className="sp-row">
                      <div>
                        <div className="sp-row-name">{c.name}</div>
                        <div className="sp-row-sub">{c.evidence}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          );
        })}
      </div>

      <div className="sp-bezel">
        <div className="sp-core sp-pipe-final">
          <h2>Queued to send: {QUEUED.length}</h2>
          <p className="sp-panel-sub">
            These passed every check. In watch-mode they are queued on paper
            only — nothing goes out until you turn sending on.
          </p>
          <div className="sp-pillwrap">
            {QUEUED.map((c) => (
              <span key={c.id} className="sp-name-pill">{c.name}</span>
            ))}
          </div>
        </div>
      </div>
      <IngestFootnote />
    </>
  );
}

function PipelineEmpty() {
  return (
    <>
      <div className="sp-bezel">
        <div className="sp-core sp-pipe-final">
          <h2>Every list you upload goes through six checks</h2>
          <p className="sp-panel-sub">
            Upload a CSV of recent customers, attest to their consent, and
            RepWorth shows you who it would ask — and who it would hold back
            at each of these gates. Watch-mode sends nothing.
          </p>
          <button type="button" className="sp-btn-primary">
            Upload contacts CSV
          </button>
        </div>
      </div>
      <div className="sp-pipe-rail sp-pipe-rail--ghost">
        {REASON_ORDER.map((reason, index) => (
          <div key={reason} className="sp-stage sp-stage--ghost">
            <div className="sp-stage-head">
              <span className="sp-stage-step">{index + 1}</span>
              <span className="sp-stage-gate">{REASON_META[reason].gate}</span>
              <ReasonChip reason={reason} />
              <span className="sp-stage-count">—</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Variant C — “Register”: stat tiles + one filterable table           */
/* ------------------------------------------------------------------ */

type Filter = 'all' | Outcome;

function VariantRegister() {
  const [filter, setFilter] = useState<Filter>('all');
  const visible = useMemo(
    () => (filter === 'all' ? BATCH : BATCH.filter((c) => c.outcome === filter)),
    [filter],
  );

  const tiles: Array<{ label: string; value: number; tone?: string }> = [
    { label: 'Valid candidates', value: BATCH.length },
    { label: 'Would send', value: QUEUED.length, tone: 'send' },
    { label: 'Held back', value: WITHHELD.length, tone: 'hold' },
    { label: 'Banked for next batch', value: BANKED.length, tone: 'bank' },
  ];

  return (
    <>
      <WatchModeBanner />
      <div className="sp-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="sp-bezel">
            <div className={`sp-core sp-tile ${t.tone ? `sp-tile--${t.tone}` : ''}`}>
              <span className="sp-tile-num">{t.value}</span>
              <span className="sp-tile-label">{t.label}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="sp-filterbar" role="group" aria-label="Filter by decision">
        <button
          type="button"
          className={`sp-filter ${filter === 'all' ? 'sp-filter--on' : ''}`}
          onClick={() => setFilter('all')}
        >
          All · {BATCH.length}
        </button>
        <button
          type="button"
          className={`sp-filter ${filter === 'queued' ? 'sp-filter--on' : ''}`}
          onClick={() => setFilter('queued')}
        >
          queued · {QUEUED.length}
        </button>
        {REASON_ORDER.map((reason) => (
          <button
            key={reason}
            type="button"
            className={`sp-filter ${filter === reason ? 'sp-filter--on' : ''}`}
            onClick={() => setFilter(reason)}
          >
            {reason} · {byReason(reason).length}
          </button>
        ))}
      </div>

      <div className="sp-bezel">
        <div className="sp-core">
          <table className="sp-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Contact</th>
                <th>Last visit</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id}>
                  <td className="sp-row-name">{c.name}</td>
                  <td className="sp-row-sub">{c.handle}</td>
                  <td className="sp-row-sub">{c.lastVisit}</td>
                  <td>
                    {c.outcome === 'queued' ? (
                      <span className="sp-chip sp-chip--send">queued</span>
                    ) : (
                      <>
                        <ReasonChip reason={c.outcome} />
                        <div className="sp-row-sub sp-evidence">{c.evidence}</div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <IngestFootnote />
    </>
  );
}

function RegisterEmpty() {
  return (
    <>
      <div className="sp-dropzone">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 16V4m0 0-4 4m4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <div>
          <strong>Drop a contacts CSV here</strong>
          <p className="sp-row-sub">
            Recent customers only, with your consent attestation. Watch-mode
            plans the asks and sends nothing.
          </p>
        </div>
        <button type="button" className="sp-btn-primary">Browse files</button>
      </div>
      <div className="sp-bezel">
        <div className="sp-core">
          <table className="sp-table sp-table--ghost" aria-hidden="true">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Contact</th>
                <th>Last visit</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4].map((row) => (
                <tr key={row}>
                  <td><span className="sp-ghost sp-ghost--w40" /></td>
                  <td><span className="sp-ghost sp-ghost--w32" /></td>
                  <td><span className="sp-ghost sp-ghost--w16" /></td>
                  <td><span className="sp-ghost sp-ghost--w24" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Switcher + page shell                                               */
/* ------------------------------------------------------------------ */

const VARIANTS = [
  { key: 'A', name: 'Ledger — send vs spoilage, side by side' },
  { key: 'B', name: 'Pipeline — the six gates as a funnel' },
  { key: 'C', name: 'Register — stat tiles + filterable table' },
] as const;

type VariantKey = (typeof VARIANTS)[number]['key'];

export function SolicitationPrototype() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const variantParam = searchParams?.get('variant') ?? 'A';
  const variant: VariantKey = VARIANTS.some((v) => v.key === variantParam)
    ? (variantParam as VariantKey)
    : 'A';
  const empty = searchParams?.get('state') === 'empty';

  const go = (nextVariant: VariantKey, nextEmpty: boolean) => {
    const params = new URLSearchParams({ variant: nextVariant });
    if (nextEmpty) params.set('state', 'empty');
    router.replace(`/dashboard/solicitation-prototype?${params.toString()}`, {
      scroll: false,
    });
  };

  const currentIndex = VARIANTS.findIndex((v) => v.key === variant);
  const cycle = (delta: number) => {
    const next = VARIANTS[(currentIndex + delta + VARIANTS.length) % VARIANTS.length];
    if (next) go(next.key, empty);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
      <TopBar
        title="Review requests"
        subtitle="Watch-mode · a plan for your last upload, with nothing sent."
      />
      <div className="content sp-content">
        {empty ? (
          <>
            {variant === 'A' && <LedgerEmpty />}
            {variant === 'B' && <PipelineEmpty />}
            {variant === 'C' && <RegisterEmpty />}
          </>
        ) : (
          <>
            {variant === 'A' && <VariantLedger />}
            {variant === 'B' && <VariantPipeline />}
            {variant === 'C' && <VariantRegister />}
          </>
        )}
      </div>

      <div className="sp-switcher" role="toolbar" aria-label="Prototype variant switcher">
        <button type="button" className="sp-sw-arrow" onClick={() => cycle(-1)} aria-label="Previous variant">
          ←
        </button>
        <span className="sp-sw-label">
          {variant} — {VARIANTS[currentIndex]?.name}
        </span>
        <button type="button" className="sp-sw-arrow" onClick={() => cycle(1)} aria-label="Next variant">
          →
        </button>
        <span className="sp-sw-divider" />
        <button type="button" className="sp-sw-toggle" onClick={() => go(variant, !empty)}>
          {empty ? 'Show batch' : 'Show empty state'}
        </button>
      </div>
    </>
  );
}
