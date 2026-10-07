import { mapSideFromStorage, mapSideToStorage } from './review.dto';

// Pure mapper tests are the cheapest proof of the API/storage side convention.
describe('review diff side mapping', () => {
  it.each([
    ['old', 'left'],
    ['new', 'right'],
    [null, null],
  ] as const)('maps API %s to storage %s in both directions', (apiSide, storageSide) => {
    expect(mapSideToStorage(apiSide)).toBe(storageSide);
    expect(mapSideFromStorage(storageSide)).toBe(apiSide);
  });
});
