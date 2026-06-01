import { describe, expect, it } from 'vitest';
import { getBriefBullets } from '../brief-bullets';

describe('getBriefBullets', () => {
  it('normalizes markdown bullets and numbered lines', () => {
    expect(getBriefBullets('- Fast service\n2. Friendly staff')).toEqual([
      { key: '0:Fast service', text: 'Fast service' },
      { key: '0:Friendly staff', text: 'Friendly staff' },
    ]);
  });

  it('keeps duplicate bullet keys unique', () => {
    expect(getBriefBullets('- Fast service\n- Fast service')).toEqual([
      { key: '0:Fast service', text: 'Fast service' },
      { key: '1:Fast service', text: 'Fast service' },
    ]);
  });
});
