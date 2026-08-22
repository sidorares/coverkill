import { describe, expect, it } from 'vitest';
import { subtractRanges } from './merge.js';

describe('subtractRanges', () => {
  it('punches holes in covered ranges', () => {
    const covered = [{ start: 0, end: 100 }];
    const holes = [{ start: 40, end: 60 }];
    expect(subtractRanges(covered, holes)).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });
});
