// @vitest-environment jsdom
//
// UX audit D8 + D1 on the dashboard landing. Source assertions, for the same
// reason DashboardContent.importOffer.test.tsx gives: rendering
// DashboardOperationalContent for real needs a harness bigger than the thing
// under test, and the failure modes here — the strip moving back to the foot,
// the skeleton coming back on every refresh — are structural, not behavioural.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/components/dashboard/DashboardContent.tsx'),
  'utf8',
);

describe('DashboardContent — approvals placement and stale-while-revalidate', () => {
  it('leads with the approvals strip, under the banners, while drafts are waiting', () => {
    const leadStrip = source.indexOf('{hasPendingApprovals && (');
    const heroRow = source.indexOf('Zone 1 — hero row');
    expect(leadStrip).toBeGreaterThan(-1);
    expect(heroRow).toBeGreaterThan(-1);
    expect(leadStrip).toBeLessThan(heroRow);
    // …and the strip in that lead slot carries the real count.
    expect(source.slice(leadStrip, heroRow)).toMatch(
      /<PendingApprovalsStrip count=\{reputation\.pendingApprovalCount\} \/>/,
    );
  });

  it('keeps the calm strip beside Analytics only when nothing is waiting', () => {
    expect(source).toMatch(/hasPendingApprovals \? \([\s\S]*?<AnalyticsLinkCard \/>[\s\S]*?\) : \([\s\S]*?dash-pair[\s\S]*?<PendingApprovalsStrip count=\{0\} \/>/);
  });

  it('shows the error card and the skeleton only while nothing is on screen', () => {
    expect(source).toMatch(/if \(error && !data\)/);
    expect(source).toMatch(/if \(!data\) \{/);
    expect(source).not.toMatch(/if \(loading \|\| !data\)/);
  });
});
