import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HowItWorksContent } from '../HowItWorksContent';

describe('HowItWorksContent', () => {
  it('renders the final CTA as an early access waitlist form', () => {
    const html = renderToStaticMarkup(createElement(HowItWorksContent));

    expect(html).toContain('Join waitlist');
    expect(html).toContain('value="how-it-works"');
    expect(html).toContain('value="waitlist"');
    // SiteFooter renders `class="rw-foot flex-col items-stretch"`.
    expect(html).toContain('class="rw-foot');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).not.toContain('Book a Demo');
  });

  it('states only claims true to the system', () => {
    const html = renderToStaticMarkup(createElement(HowItWorksContent));

    // removed false/contradicting claims
    expect(html).not.toContain('No auto-post, ever');
    expect(html).not.toContain('Approval is a hard gate');
    expect(html).not.toContain('past 30 owner responses');
    expect(html).not.toContain('import your last 30 owner responses');
    expect(html).not.toContain('Google Business API');
    expect(html).not.toContain('voice model v3');
    expect(html).not.toContain('Matches you');
    expect(html).not.toContain('out of the box');
    // voice learning is edit-driven: plain approvals and pre-existing Google
    // replies never enter the corpus (voice-learning.ts: edited_text IS NOT NULL)
    expect(html).not.toContain('approve and edit');
    expect(html).not.toContain('learns from your existing replies');
    // triage severity vocabulary is low/medium/high (triage-schema.ts), and the
    // escalation trigger is Guardian's suggested_action, not a severity level
    expect(html).not.toContain('routine, elevated, or critical');
    expect(html).not.toContain('critical ones escalate');
    // the Judge evaluates a fixed platform safety rubric — it receives neither
    // the owner's policy row nor any brand-voice context (judge.ts)
    expect(html).not.toContain('your policy and your brand');
    // Telegram and WhatsApp are off in production — email is the only live
    // approval channel; do not name the others until their flags are on
    expect(html).not.toContain('Telegram');
    expect(html).not.toContain('WhatsApp');

    // present, corrected claims
    expect(html).toContain('edits you make');
    expect(html).toContain('low, medium, or high');
    expect(html).toContain('fixed safety rubric');
    expect(html).toContain('Multi-location supported on Copilot and Autopilot');

    // new pipeline claims
    expect(html).toContain('Guardian reads it before anyone answers.');
    expect(html).toContain('Copilot asks you. Autopilot asks your policy.');
    expect(html).toContain('Every auto-post gets a second opinion.');
    expect(html).toContain('Negative reviews are never auto-posted');
    expect(html).toContain('of auto-posts judged');
    expect(html).toContain('Typical figures shown for illustration');
    expect(html).toContain('Sample walkthrough: illustrative reviews and business, not real customers.');
    // stale claims gone
    expect(html).not.toContain('Four steps from new review');
    expect(html).not.toContain('15 hrs');
    expect(html).not.toContain('saved weekly');
    expect(html).not.toContain('just four well-behaved services');
  });
});
