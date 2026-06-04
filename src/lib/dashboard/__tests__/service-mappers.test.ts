import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildActiveDashboardResponse,
  buildDashboardSettings,
  buildRanking,
  buildValueSummary,
  parsePendingFlow,
  selectLatestBrief,
  type DashboardBusinessRow,
} from '../service-mappers';

function businessRow(
  overrides: Partial<DashboardBusinessRow> = {},
): DashboardBusinessRow {
  return {
    name: 'Acme',
    created_at: new Date('2026-01-01T00:00:00Z'),
    initial_review_count: null,
    initial_responded_count: null,
    baseline_captured_at: null,
    tone: null,
    products_services: null,
    avoid_facts: null,
    sample_responses: null,
    owner_phone: null,
    owner_email: null,
    weekly_summary_enabled: null,
    monthly_impact_enabled: null,
    category: null,
    google_place_id: null,
    ...overrides,
  };
}

describe('dashboard service mappers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('groups ranking snapshots by keyword without reordering snapshots', () => {
    expect(
      buildRanking([
        { keyword: 'pizza', snapshot_date: '2026-05-01', rank_position: 4 },
        { keyword: 'pizza', snapshot_date: '2026-05-08', rank_position: 2 },
        { keyword: 'wings', snapshot_date: '2026-05-01', rank_position: 7 },
      ]),
    ).toEqual([
      {
        keyword: 'pizza',
        snapshots: [
          { date: '2026-05-01', position: 4 },
          { date: '2026-05-08', position: 2 },
        ],
      },
      {
        keyword: 'wings',
        snapshots: [{ date: '2026-05-01', position: 7 }],
      },
    ]);
  });

  it('returns null ranking when there are no snapshots', () => {
    expect(buildRanking([])).toBeNull();
  });

  it('selects the most recently sent brief', () => {
    expect(
      selectLatestBrief(
        {
          summary_text: 'Monthly summary',
          month_start_date: '2026-04-01',
          sent_at: '2026-05-01T09:00:00Z',
        },
        {
          summary_text: 'Weekly summary',
          week_start_date: '2026-05-04',
          sent_at: '2026-05-05T09:00:00Z',
        },
      ),
    ).toEqual({
      text: 'Weekly summary',
      type: 'weekly',
      periodLabel: 'Week of 2026-05-04',
    });
  });

  it('keeps the monthly brief when sent at the same time as weekly', () => {
    expect(
      selectLatestBrief(
        {
          summary_text: 'Monthly summary',
          month_start_date: '2026-04-01',
          sent_at: '2026-05-01T09:00:00Z',
        },
        {
          summary_text: 'Weekly summary',
          week_start_date: '2026-05-04',
          sent_at: '2026-05-01T09:00:00Z',
        },
      ),
    ).toEqual({
      text: 'Monthly summary',
      type: 'monthly',
      periodLabel: 'April 2026',
    });
  });

  it('selects the monthly brief when it was sent more recently than the weekly', () => {
    expect(
      selectLatestBrief(
        {
          summary_text: 'Monthly summary',
          month_start_date: '2026-04-01',
          sent_at: '2026-05-10T09:00:00Z',
        },
        {
          summary_text: 'Weekly summary',
          week_start_date: '2026-05-04',
          sent_at: '2026-05-05T09:00:00Z',
        },
      ),
    ).toEqual({
      text: 'Monthly summary',
      type: 'monthly',
      periodLabel: 'April 2026',
    });
  });

  it('returns null when neither brief has summary text', () => {
    expect(
      selectLatestBrief(
        { month_start_date: '2026-04-01', sent_at: '2026-05-10T09:00:00Z' },
        undefined,
      ),
    ).toBeNull();
  });

  it('parses valid pending flow markers and ignores malformed markers', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      parsePendingFlow(JSON.stringify({
        status: 'oauth_in_progress',
        started_at: 1770000000000,
      })),
    ).toEqual({
      status: 'oauth_in_progress',
      started_at: 1770000000000,
    });
    expect(parsePendingFlow('{not-json')).toBeUndefined();
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it('rejects a marker whose status is a string but not an allowed value', () => {
    // Valid JSON, plausible shape, but an out-of-union status must not leak
    // into pendingFlow — and this is not a parse error, so nothing is logged.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      parsePendingFlow(JSON.stringify({ status: 'bogus_status', started_at: 1770000000000 })),
    ).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('builds value summary and baseline response rate', () => {
    expect(
      buildValueSummary(
        10,
        8,
        businessRow({
          baseline_captured_at: '2026-01-02T00:00:00Z',
          initial_review_count: 20,
          initial_responded_count: 5,
        }),
      ),
    ).toEqual({
      totalReviewsHandled: 8,
      totalTimeSavedMinutes: 56,
      currentResponseRate: 80,
      baselineResponseRate: 25,
    });
  });

  it('builds dashboard settings with defaults', () => {
    expect(
      buildDashboardSettings(
        businessRow({
          avoid_facts: ['avoid discounts'],
          sample_responses: JSON.stringify(['Thanks', 'We appreciate it']),
        }),
      ),
    ).toEqual({
      tone: 'professional and friendly',
      productsServices: '',
      avoidFacts: ['avoid discounts'],
      sampleResponses: ['Thanks', 'We appreciate it'],
      ownerPhone: '',
      ownerEmail: '',
      weeklySummaryEnabled: true,
      monthlyImpactEnabled: true,
      category: '',
      googlePlaceId: '',
    });
  });

  it('assembles the full active dashboard payload, wiring each raw input to its output field', () => {
    expect(
      buildActiveDashboardResponse({
        business: businessRow({
          name: 'Acme Diner',
          created_at: new Date('2026-01-01T00:00:00Z'),
          baseline_captured_at: '2026-01-02T00:00:00Z',
          initial_review_count: 20,
          initial_responded_count: 5,
        }),
        totalReviews: 10,
        totalResponded: 8,
        velocityRows: [],
        rankingRows: [
          { keyword: 'pizza', snapshot_date: '2026-05-01', rank_position: 4 },
        ],
        recentReviewRows: [],
        monthlyBrief: undefined,
        weeklyBrief: {
          summary_text: 'Weekly summary',
          week_start_date: '2026-05-04',
          sent_at: '2026-05-05T09:00:00Z',
        },
        zernioRow: { status: 'disconnected', disconnect_reason: 'token_revoked' },
        queuedReconnectCount: 2,
        hasUnresolvedIncident: false,
        pendingRaw: null,
      }),
    ).toEqual({
      business: { name: 'Acme Diner', createdAt: '2026-01-01T00:00:00.000Z' },
      valueSummary: {
        totalReviewsHandled: 8,
        totalTimeSavedMinutes: 56,
        currentResponseRate: 80,
        baselineResponseRate: 25,
      },
      reviewVelocity: [],
      ranking: [
        { keyword: 'pizza', snapshots: [{ date: '2026-05-01', position: 4 }] },
      ],
      recentReviews: [],
      latestBrief: {
        text: 'Weekly summary',
        type: 'weekly',
        periodLabel: 'Week of 2026-05-04',
      },
      settings: {
        tone: 'professional and friendly',
        productsServices: '',
        avoidFacts: [],
        sampleResponses: [],
        ownerPhone: '',
        ownerEmail: '',
        weeklySummaryEnabled: true,
        monthlyImpactEnabled: true,
        category: '',
        googlePlaceId: '',
      },
      zernioConnection: {
        status: 'disconnected',
        pendingFlow: undefined,
        queuedReconnectCount: 2,
        hasUnresolvedIncident: false,
        lastDisconnectReason: 'token_revoked',
      },
    });
  });
});
