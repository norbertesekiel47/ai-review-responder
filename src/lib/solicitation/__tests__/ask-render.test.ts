import { describe, expect, it } from 'vitest';
import {
  assembleAskBody,
  REVIEW_LINK_PLACEHOLDER,
  UNSUBSCRIBE_URL_PLACEHOLDER,
  type AskFooterInput,
} from '../ask-render';

const FOOTER: AskFooterInput = {
  businessName: "Joe's Diner",
  postalAddress: '123 Main St\nAustin, TX 78701',
};

const LLM_BODY = 'Hi Dana — thanks for stopping by last week. It was great to see you.';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('placeholder constants', () => {
  it('are the exact bytes #630 substitutes at dispatch (AMEND B4)', () => {
    expect(UNSUBSCRIBE_URL_PLACEHOLDER).toBe('{{unsubscribe_url}}');
    expect(REVIEW_LINK_PLACEHOLDER).toBe('{{review_link}}');
  });
});

describe('assembleAskBody', () => {
  it('assembles the exact byte contract: body, review-link line, separator, identification, address, unsubscribe', () => {
    expect(assembleAskBody(LLM_BODY, FOOTER)).toBe(
      'Hi Dana — thanks for stopping by last week. It was great to see you.\n' +
        '\n' +
        'Leave a review: {{review_link}}\n' +
        '\n' +
        '---\n' +
        '\n' +
        "Sent by RepWorth on behalf of Joe's Diner.\n" +
        '123 Main St\n' +
        'Austin, TX 78701\n' +
        'Unsubscribe: {{unsubscribe_url}}',
    );
  });

  it('is byte-deterministic: identical inputs produce identical bytes', () => {
    const first = assembleAskBody(LLM_BODY, FOOTER);
    const second = assembleAskBody(LLM_BODY, { ...FOOTER });
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('returns null when postalAddress is null (render fails closed, #622 §7.6)', () => {
    expect(assembleAskBody(LLM_BODY, { businessName: "Joe's Diner", postalAddress: null })).toBeNull();
  });

  it('returns null when postalAddress is blank or whitespace-only', () => {
    expect(assembleAskBody(LLM_BODY, { businessName: "Joe's Diner", postalAddress: '' })).toBeNull();
    expect(assembleAskBody(LLM_BODY, { businessName: "Joe's Diner", postalAddress: '  \n\t ' })).toBeNull();
  });

  it('contains each placeholder exactly once (lint class 7 precondition)', () => {
    const body = assembleAskBody(LLM_BODY, FOOTER);
    expect(body).not.toBeNull();
    expect(countOccurrences(body!, REVIEW_LINK_PLACEHOLDER)).toBe(1);
    expect(countOccurrences(body!, UNSUBSCRIBE_URL_PLACEHOLDER)).toBe(1);
  });

  it('bakes the postal address in verbatim, including internal newlines (#622 §7.6 byte-match)', () => {
    const address = ' Suite 4B\n99 Elm Road\nPortland, OR 97201 ';
    const body = assembleAskBody(LLM_BODY, { businessName: 'Elm Spa', postalAddress: address });
    expect(body).toContain(address);
  });

  it('normalizes surrounding whitespace on the LLM body so footer spacing stays canonical', () => {
    const padded = assembleAskBody(`\n  ${LLM_BODY}\n\n`, FOOTER);
    expect(padded).toBe(assembleAskBody(LLM_BODY, FOOTER));
  });
});
