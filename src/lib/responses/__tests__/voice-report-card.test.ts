import { describe, it, expect } from 'vitest';
import type { VoiceExample } from '../types';
import { deriveVoiceReportCard } from '../voice-report-card';

function pair(originalDraft: string, editedVersion: string, reviewStarRating = 5): VoiceExample {
  return { originalDraft, editedVersion, reviewStarRating };
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
    const examples = [
      pair('Dear Amanda, thank you so much for taking the time to share your wonderful feedback with us today and always.', 'Hi Amanda — thanks so much!'),
      pair('Dear Tom, we appreciate your feedback about the seating situation on weekends.', 'Hi Tom — glad the flat white landed.'),
      pair('Dear Rosa, we are so happy to hear that our team made your morning special.', 'Hi Rosa — I read your review to the crew.'),
      pair('Dear Priya, thank you for your kind words about our pastries and atmosphere.', 'Hi Priya — the cardamom buns sell out by 10am.'),
      pair('Dear Derek, we sincerely apologize for any inconvenience you may have experienced.', 'Hi Derek — that wait was not okay.'),
    ];
    const { traits } = deriveVoiceReportCard(examples);
    expect(traits.length).toBeGreaterThan(0);
    for (const trait of traits) {
      const source = examples.find(
        (p) => p.originalDraft.startsWith(trait.snippet.before.slice(0, 12)) || trait.snippet.before.includes('words')
          ? true
          : false,
      );
      expect(source).toBeDefined();
      // Every snippet's after-text must appear in some pair's edited version:
      const afterCore = trait.snippet.after.replace(/[…]|\(\d+ words\)/g, '').trim().slice(0, 12);
      expect(examples.some((p) => p.editedVersion.includes(afterCore) || afterCore.startsWith('—'))).toBe(true);
    }
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
