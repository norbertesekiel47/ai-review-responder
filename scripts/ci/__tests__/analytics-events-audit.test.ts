import { describe, it, expect } from 'vitest';
import { auditAnalyticsEvents } from '../analytics-events-audit';

const liveDoc = (name: string) => `### \`${name}\`\n- **Status:** live\n`;

describe('auditAnalyticsEvents', () => {
  it('passes when code and live docs match', () => {
    const doc = liveDoc('signup_started') + liveDoc('email_verified');
    expect(auditAnalyticsEvents(['signup_started', 'email_verified'], doc)).toEqual([]);
  });

  it('flags a code event missing from the docs', () => {
    const doc = liveDoc('signup_started');
    expect(auditAnalyticsEvents(['signup_started', 'email_verified'], doc)).toEqual([
      { event: 'email_verified', reason: 'event in code allowlist is undocumented' },
    ]);
  });

  it('flags a documented live event missing from code', () => {
    const doc = liveDoc('signup_started') + liveDoc('ghost_event');
    expect(auditAnalyticsEvents(['signup_started'], doc)).toEqual([
      { event: 'ghost_event', reason: 'documented live event missing from code allowlist' },
    ]);
  });

  it('does not require planned or external_only doc events to exist in code', () => {
    const doc =
      liveDoc('signup_started') +
      `### \`finance_rollup_completed\`\n- **Status:** planned\n` +
      `### \`stripe_invoice_paid\`\n- **Status:** external_only\n`;
    expect(auditAnalyticsEvents(['signup_started'], doc)).toEqual([]);
  });

  it('treats a heading with no Status line as live', () => {
    const doc = `### \`signup_started\`\nsome prose\n`;
    expect(auditAnalyticsEvents([], doc)).toEqual([
      { event: 'signup_started', reason: 'documented live event missing from code allowlist' },
    ]);
  });
});
