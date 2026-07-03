import { describe, it, expect } from 'vitest';
import { escapeRegExp, lineHasPragma } from '../lib/sql-tag-scan';

describe('sql-tag-scan', () => {
  describe('escapeRegExp', () => {
    it('escapes every regex metacharacter so a vocabulary value embeds verbatim', () => {
      const hostile = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
      const re = new RegExp(`^${escapeRegExp(hostile)}$`);
      expect(re.test(hostile)).toBe(true);
      // Unescaped, '.' would match any char — prove the escape is literal.
      expect(re.test('aXb*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe(false);
    });

    it('passes plain snake_case values through unchanged', () => {
      expect(escapeRegExp('generate_response')).toBe('generate_response');
    });

    it('keeps an alternation safe when one value contains an alternation metachar', () => {
      const values = ['posted', 'a|b'].map(escapeRegExp).join('|');
      const re = new RegExp(`^(?:${values})$`);
      expect(re.test('a|b')).toBe(true);
      expect(re.test('a')).toBe(false);
      expect(re.test('b')).toBe(false);
    });
  });

  describe('lineHasPragma', () => {
    const PRAGMA = 'topic-audit-ignore';

    it('a trailing pragma exempts its own line', () => {
      const lines = ["  WHERE topic = 'publish_response' -- topic-audit-ignore: reason"];
      expect(lineHasPragma(lines, 0, PRAGMA)).toBe(true);
    });

    it('a comment-only pragma line exempts the NEXT line (SQL -- form)', () => {
      const lines = ['  -- topic-audit-ignore: reason', "  WHERE topic = 'publish_response'"];
      expect(lineHasPragma(lines, 1, PRAGMA)).toBe(true);
    });

    it('a comment-only pragma line exempts the NEXT line (TS // form)', () => {
      const lines = ['// topic-audit-ignore: reason', "await sql`...'publish_response'`"];
      expect(lineHasPragma(lines, 1, PRAGMA)).toBe(true);
    });

    it('a CODE line with a trailing pragma does NOT blanket the next line', () => {
      const lines = [
        "  topic = 'publish_response' -- topic-audit-ignore: reason",
        "  AND other_topic = 'send_notification'",
      ];
      expect(lineHasPragma(lines, 1, PRAGMA)).toBe(false);
    });

    it('returns false when neither the line nor its predecessor carries the pragma', () => {
      const lines = ['SELECT 1', "  WHERE topic = 'publish_response'"];
      expect(lineHasPragma(lines, 1, PRAGMA)).toBe(false);
    });
  });
});
