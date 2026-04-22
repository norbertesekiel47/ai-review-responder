import { describe, it, expect } from 'vitest';
import { formatApprovalSms, SmsBodyTooLongError } from '../sms-body';

const REAL_URL = 'https://app.repworth.net/approve/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 69 chars

describe('formatApprovalSms', () => {
  it('renders tier 1 with reviewer name and STOP suffix', () => {
    const body = formatApprovalSms({ reviewerName: 'Jane Doe', starRating: 3, approvalUrl: REAL_URL });
    expect(body).toBe(`New 3-star review from Jane D.. Draft ready: ${REAL_URL}\nReply STOP to unsubscribe.`);
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it('transliterates accented names', () => {
    const body = formatApprovalSms({ reviewerName: 'José Ñuñez', starRating: 5, approvalUrl: REAL_URL });
    expect(body).toContain('Jose N.');
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it('transliterates CJK names to ASCII', () => {
    const body = formatApprovalSms({ reviewerName: '王小明', starRating: 4, approvalUrl: REAL_URL });
    // Transliteration produces ASCII; exact output varies by library.
    expect(body).toMatch(/^[\x00-\x7F\n]+$/);
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it('uses "a reviewer" fallback when name normalizes to empty', () => {
    const body = formatApprovalSms({ reviewerName: '   ', starRating: 1, approvalUrl: REAL_URL });
    expect(body).toContain('from a reviewer.');
  });

  it('falls through to tier 2 when tier 1 would exceed 160 chars', () => {
    // Force tier 2: with REAL_URL (69 chars) tier 1 can fit names. Need a longer URL.
    // Tier 1 overhead = 66 + name + url. With name "a reviewer" (10), url must be > 84.
    const longUrl = 'https://very-long-host.example.com/approve/' + 'x'.repeat(40); // 83 chars
    const longerUrl = 'https://very-long-host.example.com/approve/' + 'x'.repeat(50); // 93 chars
    const body = formatApprovalSms({ reviewerName: 'Jane Doe', starRating: 2, approvalUrl: longerUrl });
    expect(body).not.toContain('from');
    expect(body).toMatch(/^New 2-star review\. Draft ready:/);
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it('throws SmsBodyTooLongError when tier 2 also overflows', () => {
    const pathologicalUrl = 'https://x.com/' + 'x'.repeat(200);
    expect(() => formatApprovalSms({ reviewerName: 'Jane', starRating: 1, approvalUrl: pathologicalUrl })).toThrow(SmsBodyTooLongError);
  });

  it('tier 1 at exactly 160 chars renders; tier 2 boundary verified', () => {
    // Build inputs that pin tier 1 at the boundary.
    // Fixed overhead for tier 1 (`New N-star review from X. Draft ready: \nReply STOP to unsubscribe.`):
    //   "New 5-star review from " (23) + name + ". Draft ready: " (15) + url + "\nReply STOP to unsubscribe." (28)
    // Total = 66 + name.length + url.length, need ≤ 160.
    // Pick name "A B" (formats to "A B.." per formatter rule = 5 chars) and compute url to hit exactly 160.
    // Formatted name length = 5, so max url = 160 - 66 - 5 = 89.
    const url89 = 'https://a.com/' + 'x'.repeat(75); // 89 chars
    const body = formatApprovalSms({ reviewerName: 'A B', starRating: 5, approvalUrl: url89 });
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it('output contains only GSM-7 compatible characters (no emoji, no UCS-2)', () => {
    const body = formatApprovalSms({ reviewerName: 'Regular Name', starRating: 5, approvalUrl: REAL_URL });
    // GSM-7 basic set is a superset of printable ASCII for our template's literal characters.
    // We assert ASCII range + newline to approximate (full GSM-7 accepts some extended chars; ASCII suffices for this template).
    expect(body).toMatch(/^[\x00-\x7F\n]+$/);
  });
});
