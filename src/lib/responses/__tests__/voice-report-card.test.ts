import { describe, it, expect } from 'vitest';
import type { VoiceExample } from '../types';
import { deriveVoiceReportCard } from '../voice-report-card';

function pair(originalDraft: string, editedVersion: string, reviewStarRating = 5): VoiceExample {
  return { originalDraft, editedVersion, reviewStarRating };
}

function makeWords(count: number, seed: string): string {
  return Array.from({ length: count }, (_, i) => `${seed}${i}`).join(' ');
}

/** Strips snippet decorations (leading em-dash, trailing "(N words)", ellipsis). */
function stripSnippetDecorations(text: string): string {
  return text
    .replace(/^\s*[—–]\s*/, '')
    .replace(/\s*\(\d+ words\)\s*$/, '')
    .replace(/…$/, '')
    .trim();
}

const FORMAL_DRAFT = 'Dear Amanda, thank you so much for taking the time to share your wonderful feedback with us today.';
const CASUAL_EDIT = 'Hi Amanda — thanks so much! See you next week. — Maria';

describe('deriveVoiceReportCard', () => {
  it('derives greeting trait only when a strict majority of pairs conform', () => {
    const conformingThree = [
      pair(FORMAL_DRAFT, 'Hi Amanda — thanks!'),
      pair('Dear Tom, we appreciate your feedback.', 'Hi Tom — glad it landed.'),
      pair('Dear Rosa, we are so happy to hear this.', 'Hi Rosa — you made our day.'),
      pair('Dear Priya, thank you for your kind words.', 'Priya, the buns sell out for a reason.'),
      pair('Dear Derek, we sincerely apologize.', 'Derek, that one is on me.'),
    ];
    const detected = deriveVoiceReportCard(conformingThree);
    expect(detected.traits.map((t) => t.key)).toContain('greeting');

    const conformingTwo = [
      pair(FORMAL_DRAFT, 'Hi Amanda — thanks!'),
      pair('Dear Tom, we appreciate your feedback.', 'Hi Tom — glad it landed.'),
      pair('Dear Rosa, we are so happy.', 'Rosa — you made our day.'),
      pair('Dear Priya, thank you kindly.', 'Priya, the buns sell out for a reason.'),
      pair('Dear Derek, we apologize.', 'Derek, that one is on me.'),
    ];
    expect(deriveVoiceReportCard(conformingTwo).traits.map((t) => t.key)).not.toContain('greeting');
  });

  it('omits critical-reviews trait when no negative pairs exist', () => {
    const allPositive = Array.from({ length: 5 }, () => pair(FORMAL_DRAFT, CASUAL_EDIT, 5));
    expect(deriveVoiceReportCard(allPositive).traits.map((t) => t.key)).not.toContain('critical');
  });

  it('detects critical-reviews trait from a single negative pair with evidence-scoped claim', () => {
    const examples = [
      pair(FORMAL_DRAFT, CASUAL_EDIT, 5),
      pair(
        'Dear Derek, we sincerely apologize for any inconvenience you may have experienced during your recent visit to our establishment.',
        'Derek, I am sorry — a 20-minute wait is not okay. Next one is on the house.',
        2,
      ),
      pair(FORMAL_DRAFT, CASUAL_EDIT, 4),
      pair(FORMAL_DRAFT, CASUAL_EDIT, 5),
      pair(FORMAL_DRAFT, CASUAL_EDIT, 5),
    ];
    const critical = deriveVoiceReportCard(examples).traits.find((t) => t.key === 'critical');
    expect(critical).toBeDefined();
    expect(critical!.claim).toContain('2-star');       // scoped to its single evidence pair
    expect(critical!.claim).not.toMatch(/critical reviews you/i); // no generalized register claim off one example
    expect(critical!.snippet.after).toContain('Derek');
  });

  it("every detected trait's snippet comes from a conforming pair", () => {
    // Corpus engineered to detect greeting, length, sign-off, AND point of
    // view, so the per-trait assertion below exercises every decoration shape.
    const examples = [
      pair(
        'Dear Amanda, we thank you so much for taking the time to share your wonderful feedback with us today and always.',
        'Hi Amanda — I loved reading this. — Maria',
      ),
      pair(
        'Dear Tom, we appreciate your feedback about the seating situation on weekends and we will review it.',
        'Hi Tom — I hear you on seating. — Maria',
      ),
      pair(
        'Dear Rosa, we are so happy to hear that our team made your morning special today.',
        'Hi Rosa — I read your review to my crew. — Maria',
      ),
      pair('Dear Priya, thank you for your kind words about our pastries and atmosphere.', 'Hi Priya — the cardamom buns sell out by 10am.'),
      pair('Dear Derek, we sincerely apologize for any inconvenience you may have experienced.', 'Hi Derek — that wait was not okay.'),
    ];
    const { traits } = deriveVoiceReportCard(examples);
    expect(traits.map((t) => t.key)).toEqual(
      expect.arrayContaining(['greeting', 'length', 'signoff', 'point_of_view']),
    );
    for (const trait of traits) {
      // No escape hatches: the stripped snippet core must literally appear in
      // at least one pair's text on the matching side, for EVERY trait kind.
      const beforeCore = stripSnippetDecorations(trait.snippet.before);
      const afterCore = stripSnippetDecorations(trait.snippet.after);
      expect(beforeCore.length).toBeGreaterThan(0);
      expect(afterCore.length).toBeGreaterThan(0);
      expect(
        examples.some((p) => p.originalDraft.includes(beforeCore)),
        `snippet.before for ${trait.key} not found in any pair's originalDraft`,
      ).toBe(true);
      expect(
        examples.some((p) => p.editedVersion.includes(afterCore)),
        `snippet.after for ${trait.key} not found in any pair's editedVersion`,
      ).toBe(true);
    }
  });

  it('computes the length claim averages from conforming (cut) pairs only', () => {
    // 3 cut pairs (20-word drafts -> 10-word edits) + 2 expansions
    // (5-word drafts -> 30-word edits). Averaging over ALL pairs would yield
    // drafts 14 / edits 18 — numbers that contradict the cutting pattern.
    const examples = [
      pair(makeWords(20, 'draft'), makeWords(10, 'edit')),
      pair(makeWords(20, 'draft'), makeWords(10, 'edit')),
      pair(makeWords(20, 'draft'), makeWords(10, 'edit')),
      pair(makeWords(5, 'short'), makeWords(30, 'long')),
      pair(makeWords(5, 'short'), makeWords(30, 'long')),
    ];
    const length = deriveVoiceReportCard(examples).traits.find((t) => t.key === 'length');
    expect(length).toBeDefined();
    expect(length!.claim).toContain('average 10 words');
    expect(length!.claim).toContain('average 20');
    expect(length!.claim).not.toContain('18');
    expect(length!.claim).not.toContain('14');
  });

  it('treats a trivial negative-pair edit as non-conforming for the critical trait', () => {
    // One-word typo fix on the 2-star pair: same word count, word-set Jaccard
    // similarity ~0.82 — not a substantive rewrite, so no critical trait.
    const examples = [
      pair(
        'Dear Derek, we sincerly apologize for the wait you experienced.',
        'Dear Derek, we sincerely apologize for the wait you experienced.',
        2,
      ),
      pair(FORMAL_DRAFT, CASUAL_EDIT, 5),
      pair(FORMAL_DRAFT, CASUAL_EDIT, 5),
      pair(FORMAL_DRAFT, CASUAL_EDIT, 4),
      pair(FORMAL_DRAFT, CASUAL_EDIT, 5),
    ];
    expect(deriveVoiceReportCard(examples).traits.map((t) => t.key)).not.toContain('critical');
  });

  it('does not read a trailing exclamation clause like "— thanks so much!" as a sign-off', () => {
    const examples = Array.from({ length: 5 }, (_, i) =>
      pair(
        `Dear Guest ${i}, thank you very much for taking the time to review us.`,
        `Appreciate the visit number ${i} — thanks so much!`,
      ),
    );
    expect(deriveVoiceReportCard(examples).traits.map((t) => t.key)).not.toContain('signoff');
  });

  it('detects point-of-view trait when edits shift we-voice drafts to I-voice', () => {
    // 3 of 5 pairs conform (plural-dominant draft → singular-dominant edit);
    // the last two are meaningful edits with no first-person voice at all.
    const examples = [
      pair(
        'We are so glad you enjoyed our coffee and we hope to see you soon.',
        "I'm so glad the coffee landed. I roasted that batch myself.",
      ),
      pair(
        'We appreciate your kind words and our team thanks you.',
        'I appreciate it. I read your note to my crew.',
      ),
      pair(
        'We are sorry about the wait and our staff will do better.',
        'I am sorry about the wait. That one is on me.',
      ),
      pair('Thanks for visiting.', 'Thanks for stopping by.'),
      pair('Glad the pastries were a hit.', 'Glad the pastries were such a hit.'),
    ];

    const trait = deriveVoiceReportCard(examples).traits.find((t) => t.key === 'point_of_view');
    expect(trait).toBeDefined();
    expect(trait!.claim).toBe('You write as “I,” not “we.”');
    // Snippet must come from a conforming pair (the first one, per derivation order).
    expect(trait!.snippet.before).toContain('We are so glad you enjoyed our coffee');
    expect(trait!.snippet.after).toContain('I roasted that batch myself');
  });

  it('returns zero traits with activation when no heuristic clears the bar', () => {
    // 5 meaningful edits with no consistent pattern: mixed greetings, mixed
    // lengths (some longer), no sign-offs, we-voice edits, no negative stars.
    const examples = [
      pair('Thanks for visiting us.', 'We appreciate you taking the time to leave such a detailed and thoughtful review of your visit.'),
      pair('Hello there, thank you kindly for the review.', 'Thanks.'),
      pair('We appreciate the feedback.', 'We hear you and we are working on the weekend seating suggestions you mentioned.'),
      pair('Thank you for the five stars.', 'Much appreciated from all of us on the morning team here.'),
      pair('We are glad you enjoyed it.', 'Our whole crew says thanks for this one.'),
    ];
    const result = deriveVoiceReportCard(examples);
    expect(result.traits).toEqual([]);
    expect(result.fallbackSnippet).not.toBeNull();
    expect(result.fallbackSnippet!.before).toContain('Thanks for visiting');
  });

  it('treats a pair with identical draft and edit as non-conforming for every heuristic', () => {
    const identical = 'Hi Amanda — thanks so much! — Maria';
    const examples = Array.from({ length: 5 }, () => pair(identical, identical, 2));
    expect(deriveVoiceReportCard(examples).traits).toEqual([]);
  });
});
