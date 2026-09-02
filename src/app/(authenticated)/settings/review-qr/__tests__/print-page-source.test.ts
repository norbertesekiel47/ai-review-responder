import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// The print page is a server component with a DB read, so its two UX-audit
// fixes are asserted at the source level: a TopBar back link on screen (S23,
// hidden on paper via .print-hide) and a real @page margin so the browser
// never prints its URL/date header over the poster (S34).
const PAGE = 'src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx';

describe('review QR print page source', () => {
  it('renders a TopBar with a back link to Review QR, wrapped in .print-hide', async () => {
    const source = await readFile(PAGE, 'utf8');
    expect(source).toContain("import { TopBar } from '@/components/dashboard/shell/TopBar'");
    expect(source).toMatch(/<div className="print-hide">\s*<TopBar/);
    expect(source).toContain("rightLink={{ href: '/settings/review-qr', label: 'Back to Review QR' }}");
  });

  it('sets a 12mm @page margin inside the print stylesheet', async () => {
    const source = await readFile(PAGE, 'utf8');
    expect(source).toMatch(/@page\s*\{\s*margin:\s*12mm;\s*\}/);
    expect(source).toContain('.print-hide { display: none !important; }');
  });
});
