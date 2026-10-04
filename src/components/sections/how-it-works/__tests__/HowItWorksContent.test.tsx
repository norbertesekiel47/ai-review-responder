import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HowItWorksContent } from '../HowItWorksContent';

describe('HowItWorksContent', () => {
  it('renders the final CTA as the closed notice door, with no waitlist form (RepWorth shut down)', () => {
    const html = renderToStaticMarkup(createElement(HowItWorksContent));

    // The CTA band's h2 is the same one phrase as the pills (M4 handoff).
    expect(html).toContain('<h2 id="hiw-cta-h">RepWorth has closed.</h2>');
    expect(html).toMatch(/<a(?=[^>]*href="#hiw-cta")(?=[^>]*class="rw-pill rw-pill-forest")[^>]*>RepWorth has closed</);
    expect(html).toMatch(/<a(?=[^>]*class="rw-pill rw-pill-paper")(?=[^>]*href="\/closed")[^>]*>Read the notice</);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('value="waitlist"');
    expect(html).not.toContain('Get early access');
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

    // present, corrected claims (2026-08-16 truth pass — voice learning
    // activates after five posted, edited replies; day-one drafts use Brand
    // Voice settings; see voice-learning.ts MIN_EXAMPLES_FOR_ACTIVATION)
    expect(html).toContain('edited and posted five replies');
    expect(html).toContain('Brand Voice settings');
    expect(html).toContain('low, medium, or high');
    expect(html).toContain('fixed safety rubric');
    expect(html).toContain('Multi-location supported on Copilot and Autopilot');

    // new pipeline claims
    expect(html).toContain('Guardian reads it before anyone answers.');
    expect(html).toContain('Copilot asks you. Autopilot asks your policy.');
    expect(html).toContain('Every auto-post gets a second opinion.');
    expect(html).toContain('Negative reviews are never auto-posted');
    expect(html).toContain('of auto-posts reviewed by the Judge');
    expect(html).toContain('Typical figures shown for illustration');
    expect(html).toContain('Sample walkthrough below: illustrative reviews and business, not real customers.');
    // The stacking sentence is wrapped so how-it-works.css can drop it below 1041px,
    // where the steps are plain cards and do not stack (M16).
    expect(html).toContain('<span class="hiw-stack-hint"> Scroll: each step stacks on the last.</span>');
    // stale claims gone
    expect(html).not.toContain('Four steps from new review');
    expect(html).not.toContain('15 hrs');
    expect(html).not.toContain('saved weekly');
    expect(html).not.toContain('just four well-behaved services');

    // 2026-08-16 truth pass — claims corrected against the code
    expect(html).not.toContain('Responds from owner@'); // replies post via GBP, not from an email
    expect(html).not.toContain('Tripadvisor'); // no such roadmap item; design §2.4 names Yelp/Facebook/Apple
    expect(html).not.toContain('unflagged'); // internal word → 'pass our safety checks'
    expect(html).not.toContain('moderation check'); // → 'safety check' (OpenAI moderation add-on is off in prod)
    expect(html).not.toContain('negative lane'); // → 'reviews of 3★ or less'
    expect(html).not.toContain('independent AI reviewer'); // same model as the drafter → 'separate AI safety check'
    expect(html).not.toContain('BullMQ'); // library name, meaningless to an owner
    expect(html).not.toContain('43 sec'); // judge sweep is every 60 s
    expect(html).toContain('no made-up facts about your business'); // judge-policy.ts flags fabricated facts
    expect(html).toContain('up to 3 times a day per review'); // MAX_REGEN_PER_SUBJECT_PER_DAY
    expect(html).toContain('Email links expire after 48 hours'); // create-link.ts TTL
    expect(html).toContain('Other review platforms are on the roadmap.');
    expect(html).toContain('How do I connect my Google reviews?');
    // The loops around the pipeline (2026-09-06): request, brief, measure, record.
    expect(html).toContain('The loops that run around it.');
    for (const loop of ['Request', 'Brief', 'Measure', 'Record']) {
      expect(html).toContain(`<h3 class="hiw-loop-t">${loop}</h3>`);
    }
    expect(html).toContain('printable QR code per location');
    expect(html).toContain('Solicitor asks past customers by email');
    expect(html).toContain('Rep Pulse');
    expect(html).toContain('Restraint tab');
    expect(html).toContain('How do I get more reviews?');
    expect(html).toContain('What does the Monday brief contain?');
    expect(html).toContain('What does the dashboard show?');
    expect(html).toContain('one reply out,');
    expect(html).not.toContain('One pipeline from');
    // Solicitor is email-only and present tense; no channel that is off in prod.
    expect(html).not.toContain('SMS');
    expect(html).toContain('100 most recent reviews from the past 12 months'); // consented import window
    expect(html).toContain('safety-checked'); // Autopilot mock chip
    // The hero artifact is labelled a sample, and mocks no email.
    //
    // Daylight Gallery II decision 5 constrained the hero's email mock to ONE
    // action, because the real approval email has one button. That mock was
    // replaced (2026-08-26) — the hero now shows the pipeline the h1 promises,
    // review → gate → public reply, instead of an inbox. There is no email left
    // to misrepresent, so the decision's subject is gone rather than overruled,
    // and its concern is asserted directly: the artifact says "sample", and the
    // inbox framing this same truth pass already flagged ("replies post via
    // GBP, not from an email") is absent.
    expect(html).toContain('Sample · one review, end to end');
    expect(html).not.toContain('owner@brightlinen.com');
    // The approval-PAGE mock in step 04 is a different surface and keeps its
    // three controls; decision 5 never governed it.
    expect(html).toContain('Your approval page · no login');
  });

  it('swaps the closed door for the /signup CTA when self-serve is on', () => {
    const html = renderToStaticMarkup(
      createElement(HowItWorksContent, {
        selfServeEnabled: true,
        signupCtaLabel: 'Start your 30-day free trial',
      })
    );
    expect(html).toContain('href="/signup"');
    expect(html).toContain('Start your 30-day free trial');
    expect(html).toContain('Start with Copilot today.');
    expect(html).not.toContain('Read the notice');
  });
});
