import {
  getSavedFilters,
  saveFilter,
  renameFilter,
  deleteFilter,
  filterNameExists,
  updateFilterQuery,
  getFilterById,
  SavedFilter,
} from './saved-filters';

// Mock crypto.randomUUID for JSDOM environment
let uuidCounter = 0;
const mockRandomUUID = jest.fn(() => `mock-uuid-${++uuidCounter}`);
Object.defineProperty(global, 'crypto', {
  value: { randomUUID: mockRandomUUID },
});

describe('saved-filters LocalStorage helpers', () => {
  const projectId = 'test-project-123';
  const storageKey = `devchain:board:savedFilters:${projectId}`;

  beforeEach(() => {
    // Clear localStorage before each test
    window.localStorage.clear();
    // Reset UUID counter for predictable IDs
    uuidCounter = 0;
  });

  describe('getSavedFilters', () => {
    it('returns empty array when no filters exist', () => {
      const filters = getSavedFilters(projectId);
      expect(filters).toEqual([]);
    });

    it('returns saved filters from localStorage', () => {
      const testFilters: SavedFilter[] = [
        { id: 'filter-1', name: 'My Filter', qs: 'st=review' },
        { id: 'filter-2', name: 'Another Filter', qs: 'ar=all&st=done' },
      ];
      window.localStorage.setItem(storageKey, JSON.stringify(testFilters));

      const filters = getSavedFilters(projectId);
      expect(filters).toEqual(testFilters);
    });

    it('returns empty array for invalid JSON', () => {
      window.localStorage.setItem(storageKey, 'invalid json');

      const consoleError = jest.spyOn(console, 'error').mockImplementation();
      const filters = getSavedFilters(projectId);

      expect(filters).toEqual([]);
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it('returns empty array for non-array data', () => {
      window.localStorage.setItem(storageKey, JSON.stringify({ not: 'an array' }));

      const consoleWarn = jest.spyOn(console, 'warn').mockImplementation();
      const filters = getSavedFilters(projectId);

      expect(filters).toEqual([]);
      expect(consoleWarn).toHaveBeenCalledWith('Invalid saved filters data: expected array');
      consoleWarn.mockRestore();
    });

    it('filters out invalid filter objects', () => {
      const mixedData = [
        { id: 'valid-1', name: 'Valid Filter', qs: 'st=review' },
        { id: 123, name: 'Invalid ID', qs: 'st=done' }, // id should be string
        { id: 'missing-qs', name: 'Missing QS' }, // missing qs
        null,
        'not an object',
      ];
      window.localStorage.setItem(storageKey, JSON.stringify(mixedData));

      const filters = getSavedFilters(projectId);
      expect(filters).toHaveLength(1);
      expect(filters[0].id).toBe('valid-1');
    });
  });

  describe('saveFilter', () => {
    it('creates a new filter with UUID', () => {
      const filter = saveFilter(projectId, 'My Filter', 'st=review');

      expect(filter.id).toBeDefined();
      expect(filter.id).toBe('mock-uuid-1'); // First UUID generated
      expect(filter.name).toBe('My Filter');
      expect(filter.qs).toBe('st=review');
    });

    it('persists filter to localStorage', () => {
      saveFilter(projectId, 'My Filter', 'st=review');

      const stored = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
      expect(stored).toHaveLength(1);
      expect(stored[0].name).toBe('My Filter');
    });

    it('trims filter name', () => {
      const filter = saveFilter(projectId, '  Trimmed Name  ', 'st=review');
      expect(filter.name).toBe('Trimmed Name');
    });

    it('throws error for empty name', () => {
      expect(() => saveFilter(projectId, '', 'st=review')).toThrow('Filter name cannot be empty');
      expect(() => saveFilter(projectId, '   ', 'st=review')).toThrow(
        'Filter name cannot be empty',
      );
    });

    it('throws error for duplicate name (case-insensitive)', () => {
      saveFilter(projectId, 'My Filter', 'st=review');

      expect(() => saveFilter(projectId, 'My Filter', 'st=done')).toThrow(
        'A filter named "My Filter" already exists',
      );
      expect(() => saveFilter(projectId, 'MY FILTER', 'st=done')).toThrow(
        'A filter named "MY FILTER" already exists',
      );
      expect(() => saveFilter(projectId, 'my filter', 'st=done')).toThrow(
        'A filter named "my filter" already exists',
      );
    });

    it('allows multiple filters with unique names', () => {
      saveFilter(projectId, 'Filter One', 'st=review');
      saveFilter(projectId, 'Filter Two', 'st=done');

      const filters = getSavedFilters(projectId);
      expect(filters).toHaveLength(2);
    });
  });

  describe('renameFilter', () => {
    it('renames an existing filter', () => {
      const filter = saveFilter(projectId, 'Old Name', 'st=review');
      renameFilter(projectId, filter.id, 'New Name');

      const filters = getSavedFilters(projectId);
      expect(filters[0].name).toBe('New Name');
    });

    it('trims new name', () => {
      const filter = saveFilter(projectId, 'Old Name', 'st=review');
      renameFilter(projectId, filter.id, '  Trimmed  ');

      const filters = getSavedFilters(projectId);
      expect(filters[0].name).toBe('Trimmed');
    });

    it('throws error for empty new name', () => {
      const filter = saveFilter(projectId, 'My Filter', 'st=review');

      expect(() => renameFilter(projectId, filter.id, '')).toThrow('Filter name cannot be empty');
    });

    it('throws error for non-existent filter', () => {
      expect(() => renameFilter(projectId, 'non-existent-id', 'New Name')).toThrow(
        'Filter not found',
      );
    });

    it('throws error for duplicate name with another filter', () => {
      const filter1 = saveFilter(projectId, 'Filter One', 'st=review');
      saveFilter(projectId, 'Filter Two', 'st=done');

      expect(() => renameFilter(projectId, filter1.id, 'Filter Two')).toThrow(
        'A filter named "Filter Two" already exists',
      );
    });

    it('allows renaming to same name (no-op)', () => {
      const filter = saveFilter(projectId, 'My Filter', 'st=review');
      renameFilter(projectId, filter.id, 'My Filter');

      const filters = getSavedFilters(projectId);
      expect(filters[0].name).toBe('My Filter');
    });
  });

  describe('deleteFilter', () => {
    it('deletes an existing filter', () => {
      const filter = saveFilter(projectId, 'My Filter', 'st=review');
      expect(getSavedFilters(projectId)).toHaveLength(1);

      deleteFilter(projectId, filter.id);
      expect(getSavedFilters(projectId)).toHaveLength(0);
    });

    it('is a no-op for non-existent filter', () => {
      saveFilter(projectId, 'My Filter', 'st=review');

      deleteFilter(projectId, 'non-existent-id');
      expect(getSavedFilters(projectId)).toHaveLength(1);
    });

    it('only deletes the specified filter', () => {
      const filter1 = saveFilter(projectId, 'Filter One', 'st=review');
      saveFilter(projectId, 'Filter Two', 'st=done');

      deleteFilter(projectId, filter1.id);

      const filters = getSavedFilters(projectId);
      expect(filters).toHaveLength(1);
      expect(filters[0].name).toBe('Filter Two');
    });
  });

  describe('filterNameExists', () => {
    it('returns false when no filters exist', () => {
      expect(filterNameExists(projectId, 'Any Name')).toBe(false);
    });

    it('returns true for existing name (exact match)', () => {
      saveFilter(projectId, 'My Filter', 'st=review');
      expect(filterNameExists(projectId, 'My Filter')).toBe(true);
    });

    it('returns true for existing name (case-insensitive)', () => {
      saveFilter(projectId, 'My Filter', 'st=review');

      expect(filterNameExists(projectId, 'my filter')).toBe(true);
      expect(filterNameExists(projectId, 'MY FILTER')).toBe(true);
      expect(filterNameExists(projectId, 'My FiLtEr')).toBe(true);
    });

    it('returns false for non-existing name', () => {
      saveFilter(projectId, 'My Filter', 'st=review');
      expect(filterNameExists(projectId, 'Other Filter')).toBe(false);
    });
  });

  describe('updateFilterQuery', () => {
    it('updates the query string of an existing filter', () => {
      const filter = saveFilter(projectId, 'My Filter', 'st=review');
      updateFilterQuery(projectId, filter.id, 'ar=all&st=done');

      const filters = getSavedFilters(projectId);
      expect(filters[0].qs).toBe('ar=all&st=done');
    });

    it('throws error for non-existent filter', () => {
      expect(() => updateFilterQuery(projectId, 'non-existent-id', 'st=done')).toThrow(
        'Filter not found',
      );
    });
  });

  describe('getFilterById', () => {
    it('returns the filter with matching ID', () => {
      const filter = saveFilter(projectId, 'My Filter', 'st=review');
      const found = getFilterById(projectId, filter.id);

      expect(found).toBeDefined();
      expect(found?.name).toBe('My Filter');
    });

    it('returns undefined for non-existent ID', () => {
      saveFilter(projectId, 'My Filter', 'st=review');
      const found = getFilterById(projectId, 'non-existent-id');

      expect(found).toBeUndefined();
    });
  });

  describe('project isolation', () => {
    it('filters are isolated per project', () => {
      saveFilter('project-1', 'Filter A', 'st=review');
      saveFilter('project-2', 'Filter B', 'st=done');

      expect(getSavedFilters('project-1')).toHaveLength(1);
      expect(getSavedFilters('project-1')[0].name).toBe('Filter A');

      expect(getSavedFilters('project-2')).toHaveLength(1);
      expect(getSavedFilters('project-2')[0].name).toBe('Filter B');
    });

    it('same filter name can exist in different projects', () => {
      saveFilter('project-1', 'My Filter', 'st=review');
      saveFilter('project-2', 'My Filter', 'st=done');

      expect(getSavedFilters('project-1')[0].qs).toBe('st=review');
      expect(getSavedFilters('project-2')[0].qs).toBe('st=done');
    });
  });
});
