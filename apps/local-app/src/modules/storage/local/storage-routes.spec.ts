// A route-table unit check catches accidental reader classification without booting storage.
import { STORAGE_ROUTES } from './storage-routes';

describe('Storage route admission classification', () => {
  it('classifies every write-named method as a writer', () => {
    const writeName =
      /^(create|update|delete|set|upsert|apply|add|remove|replace|reorder|claim|park|release|mark|record|save|rename|checkout|disconnect|confirm|prepare|clear|store|assign|bulk)/;
    const misclassified = Object.entries(STORAGE_ROUTES)
      .filter(([name, route]) => writeName.test(name) && route.scope === 'read')
      .map(([name]) => name);

    expect(misclassified).toEqual([]);
  });

  it('documents a reason for every exempt writer', () => {
    const missingReasons = Object.entries(STORAGE_ROUTES)
      .filter(([, route]) => route.scope === 'exempt' && !route.reason.trim())
      .map(([name]) => name);

    expect(missingReasons).toEqual([]);
  });
});
