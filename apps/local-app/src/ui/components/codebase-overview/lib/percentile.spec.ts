import { percentile } from './percentile';

describe('percentile', () => {
  it('returns 0 for empty array', () => {
    expect(percentile([], 75)).toBe(0);
  });

  it('returns the single value for a one-element array', () => {
    expect(percentile([42], 50)).toBe(42);
  });

  it('returns the minimum for p=0', () => {
    expect(percentile([10, 20, 30, 40, 50], 0)).toBe(10);
  });

  it('returns the maximum for p=100', () => {
    expect(percentile([10, 20, 30, 40, 50], 100)).toBe(50);
  });

  it('returns median for p=50 on sorted odd-length array', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('interpolates between values for non-integer index', () => {
    // 5 values [10,20,30,40,50], p=25 → index=(0.25*4)=1.0 → sorted[1]=20
    expect(percentile([10, 20, 30, 40, 50], 25)).toBe(20);
  });

  it('sorts input before computing (handles unsorted input)', () => {
    expect(percentile([50, 10, 30, 20, 40], 50)).toBe(30);
  });

  it('returns p75 correctly for a simple array', () => {
    // [1,2,3,4] sorted, p=75 → index=0.75*3=2.25 → sorted[2]+(sorted[3]-sorted[2])*0.25=3+0.25=3.25
    expect(percentile([1, 2, 3, 4], 75)).toBeCloseTo(3.25);
  });

  it('handles duplicate values', () => {
    expect(percentile([5, 5, 5, 5, 5], 75)).toBe(5);
  });
});
