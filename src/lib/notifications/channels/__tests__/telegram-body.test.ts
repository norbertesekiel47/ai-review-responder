import { describe, it, expect } from 'vitest';
import { formatApprovalTelegram } from '../telegram-body';

function sample(overrides: Partial<Parameters<typeof formatApprovalTelegram>[0]> = {}) {
  return {
    businessName: 'Acme Auto',
    reviewerName: 'Jane Doe',
    starRating: 3,
    reviewText: 'Service was okay.',
    reviewDate: '2026-04-15',
    responsePreview: 'Thanks for your feedback, Jane.',
    approvalUrl: 'https://app.repworth.net/approve/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    approvalLinkId: '01932b55-5555-7f60-9abc-abcdefabcdef',
    ...overrides,
  };
}

describe('formatApprovalTelegram', () => {
  it('returns text containing business name, star rating, and reviewer', () => {
    const { text } = formatApprovalTelegram(sample());
    expect(text).toContain('Acme Auto');
    expect(text).toContain('Jane Doe');
    expect(text).toContain('⭐3');
  });

  it('HTML-escapes special chars in reviewer name and business name', () => {
    const { text } = formatApprovalTelegram(
      sample({ reviewerName: 'Tom & Jerry <>', businessName: 'A & B' }),
    );
    expect(text).toContain('Tom &amp; Jerry &lt;&gt;');
    expect(text).toContain('A &amp; B');
    expect(text).not.toContain('<>');
  });

  it('HTML-escapes reviewText and responsePreview', () => {
    const { text } = formatApprovalTelegram(
      sample({
        reviewText: 'Loved the <b>service</b> & price',
        responsePreview: 'Thanks for <3',
      }),
    );
    expect(text).toContain('&lt;b&gt;service&lt;/b&gt;');
    expect(text).toContain('&amp;');
    expect(text).toContain('Thanks for &lt;3');
    expect(text).not.toContain('<b>service</b>');
  });

  it('escapes AFTER truncating, so entities cannot be cut mid-sequence', () => {
    // Build a string where the 400th-char boundary would fall inside an
    // HTML entity if escape happened before truncate. If the implementation
    // ever flips the order, the entity '&amp;' will be sliced and the test
    // will see a stray '&am' fragment.
    const padding = 'x'.repeat(399);
    const { text } = formatApprovalTelegram(sample({ reviewText: padding + '&' }));
    // The final char (&) must either be fully escaped to &amp; or dropped by
    // truncation — never a fragmented entity like '&am' / '&a' / '&'.
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;)[a-z]{0,3}[^;\w]/);
  });

  it('handles null reviewText gracefully', () => {
    const { text } = formatApprovalTelegram(sample({ reviewText: null }));
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('truncates long reviewText to under 400 chars with ellipsis', () => {
    const long = 'x'.repeat(800);
    const { text } = formatApprovalTelegram(sample({ reviewText: long }));
    const xCount = (text.match(/x/g) ?? []).length;
    expect(xCount).toBeLessThan(500);
    expect(text).toMatch(/…|\.\.\./);
  });

  it('inline_keyboard has exactly 3 buttons in 2 rows: approve/regenerate then edit URL', () => {
    const { inline_keyboard } = formatApprovalTelegram(sample());
    expect(inline_keyboard).toHaveLength(2);
    expect(inline_keyboard[0]).toHaveLength(2);
    expect(inline_keyboard[1]).toHaveLength(1);
    expect(inline_keyboard[0]![0]).toMatchObject({ callback_data: expect.stringMatching(/^a:/) });
    expect(inline_keyboard[0]![1]).toMatchObject({ callback_data: expect.stringMatching(/^r:/) });
    expect(inline_keyboard[1]![0]).toMatchObject({ url: expect.stringContaining('/approve/') });
  });

  it('callback_data is within Telegram 64-byte limit', () => {
    const { inline_keyboard } = formatApprovalTelegram(sample());
    const approveData = inline_keyboard[0]![0]!.callback_data!;
    const regenData = inline_keyboard[0]![1]!.callback_data!;
    expect(Buffer.byteLength(approveData, 'utf8')).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(regenData, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('callback_data embeds the approvalLinkId', () => {
    const id = '01932b55-5555-7f60-9abc-abcdefabcdef';
    const { inline_keyboard } = formatApprovalTelegram(sample({ approvalLinkId: id }));
    expect(inline_keyboard[0]![0]!.callback_data).toBe(`a:${id}`);
    expect(inline_keyboard[0]![1]!.callback_data).toBe(`r:${id}`);
  });
});
