import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('competitors settings page source', () => {
  it('keeps the competitors settings page free of Promise.all fan-out', async () => {
    const source = await readFile(
      'src/app/(authenticated)/settings/competitors/page.tsx',
      'utf8',
    );

    expect(source).not.toContain('Promise.all');
    expect(source).toContain('loadRivalPickerViews');
  });
});
