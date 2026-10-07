import {
  getSavedFilters,
  saveFilter,
  renameFilter,
  deleteFilter,
  filterNameExists,
  updateFilterQuery,
  getFilterById,
  getDefaultFilterId,
  setDefaultFilterId,
  clearDefaultFilterId,
  isFilterActive,
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
  });

  describe('renameFilter', () => {
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

  describe('generateClientId (crypto fallback)', () => {
    afterEach(() => {
      // Restore original crypto mock
      Object.defineProperty(global, 'crypto', {
        value: { randomUUID: mockRandomUUID },
        configurable: true,
      });
    });

    it('sets correct version and variant bits in fallback UUID', () => {
      Object.defineProperty(global, 'crypto', {
        value: {
          getRandomValues: (arr: Uint8Array) => {
            for (let i = 0; i < arr.length; i++) arr[i] = i;
            return arr;
          },
        },
        configurable: true,
      });

      window.localStorage.clear();
      const filter = saveFilter('bits-test', 'Test', 'st=review');

      expect(filter.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      // Version 4: third group starts with 4
      // Variant 10xx: fourth group starts with 8/9/a/b
      expect(filter.id).toMatch(/-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    });

    it('saves filter with valid shape via fallback', () => {
      Object.defineProperty(global, 'crypto', {
        value: {
          getRandomValues: (arr: Uint8Array) => {
            for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
            return arr;
          },
        },
        configurable: true,
      });

      window.localStorage.clear();
      const filter = saveFilter('shape-test', 'Shape Test', 'st=done');

      expect(filter).toEqual({
        id: expect.any(String),
        name: 'Shape Test',
        qs: 'st=done',
      });

      // Verify persisted
      const stored = getSavedFilters('shape-test');
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(filter.id);
    });
  });

  describe('default filter pointer', () => {
    const defProjectId = 'default-test-project';
    const defStorageKey = `devchain:board:defaultFilterId:${defProjectId}`;

    beforeEach(() => {
      window.localStorage.clear();
      uuidCounter = 0;
    });

    describe('getDefaultFilterId', () => {
      it('returns null when no default is set', () => {
        expect(getDefaultFilterId(defProjectId)).toBeNull();
      });

      it('returns the stored ID when the filter exists', () => {
        const filter = saveFilter(defProjectId, 'My Filter', 'st=review');
        setDefaultFilterId(defProjectId, filter.id);

        expect(getDefaultFilterId(defProjectId)).toBe(filter.id);
      });

      it('returns null and clears pointer when filter no longer exists', () => {
        const filter = saveFilter(defProjectId, 'My Filter', 'st=review');
        setDefaultFilterId(defProjectId, filter.id);

        // Directly remove the filter from storage (simulates external mutation)
        const filters = getSavedFilters(defProjectId).filter((f) => f.id !== filter.id);
        window.localStorage.setItem(
          `devchain:board:savedFilters:${defProjectId}`,
          JSON.stringify(filters),
        );

        expect(getDefaultFilterId(defProjectId)).toBeNull();
        expect(window.localStorage.getItem(defStorageKey)).toBeNull();
      });
    });

    describe('setDefaultFilterId', () => {
      it('overwrites previous default', () => {
        setDefaultFilterId(defProjectId, 'old-id');
        setDefaultFilterId(defProjectId, 'new-id');
        expect(window.localStorage.getItem(defStorageKey)).toBe('new-id');
      });
    });

    describe('clearDefaultFilterId', () => {
      it('removes the pointer from localStorage', () => {
        setDefaultFilterId(defProjectId, 'test-id');
        expect(window.localStorage.getItem(defStorageKey)).toBe('test-id');

        clearDefaultFilterId(defProjectId);
        expect(window.localStorage.getItem(defStorageKey)).toBeNull();
      });

      it('is a no-op when no default is set', () => {
        clearDefaultFilterId(defProjectId);
        expect(window.localStorage.getItem(defStorageKey)).toBeNull();
      });
    });

    describe('deleteFilter clears default pointer', () => {
      it('clears default when the deleted filter was the default', () => {
        const filter = saveFilter(defProjectId, 'My Filter', 'st=review');
        setDefaultFilterId(defProjectId, filter.id);
        expect(getDefaultFilterId(defProjectId)).toBe(filter.id);

        deleteFilter(defProjectId, filter.id);

        expect(getDefaultFilterId(defProjectId)).toBeNull();
      });

      it('does not clear default when a different filter is deleted', () => {
        const filter1 = saveFilter(defProjectId, 'Filter One', 'st=review');
        const filter2 = saveFilter(defProjectId, 'Filter Two', 'st=done');
        setDefaultFilterId(defProjectId, filter1.id);

        deleteFilter(defProjectId, filter2.id);

        expect(getDefaultFilterId(defProjectId)).toBe(filter1.id);
      });
    });

    describe('renameFilter preserves default pointer', () => {
      it('keeps the default pointer after renaming the default filter', () => {
        const filter = saveFilter(defProjectId, 'My Filter', 'st=review');
        setDefaultFilterId(defProjectId, filter.id);

        renameFilter(defProjectId, filter.id, 'Renamed Filter');

        expect(getDefaultFilterId(defProjectId)).toBe(filter.id);
        const filters = getSavedFilters(defProjectId);
        expect(filters[0].name).toBe('Renamed Filter');
      });
    });

    describe('project isolation', () => {
      it('default pointer is per-project', () => {
        const filterA = saveFilter('proj-a', 'Filter A', 'st=review');
        saveFilter('proj-b', 'Filter B', 'st=done');

        setDefaultFilterId('proj-a', filterA.id);

        expect(getDefaultFilterId('proj-a')).toBe(filterA.id);
        expect(getDefaultFilterId('proj-b')).toBeNull();
      });

      it('deleting default in one project does not affect another', () => {
        const filterA = saveFilter('proj-a', 'Filter A', 'st=review');
        const filterB = saveFilter('proj-b', 'Filter B', 'st=done');
        setDefaultFilterId('proj-a', filterA.id);
        setDefaultFilterId('proj-b', filterB.id);

        deleteFilter('proj-a', filterA.id);

        expect(getDefaultFilterId('proj-a')).toBeNull();
        expect(getDefaultFilterId('proj-b')).toBe(filterB.id);
      });
    });
  });

  describe('isFilterActive', () => {
    it.each([
      {
        label: 'returns true when saved filter qs matches current filters',
        savedQuery: 'st=review',
        currentStatus: 'review',
        expectedActive: true,
      },
      {
        label: 'returns false when filters do not match',
        savedQuery: 'st=review',
        currentStatus: 'done',
        expectedActive: false,
      },
      {
        label: 'returns false when saved filter qs is empty and current has filters',
        savedQuery: '',
        currentStatus: 'review',
        expectedActive: false,
      },
    ] as const)('$label', ({ savedQuery, currentStatus, expectedActive }) => {
      const filter: SavedFilter = { id: '1', name: 'Test', qs: savedQuery };
      const currentFilters = { status: [currentStatus] };
      expect(isFilterActive(filter, currentFilters)).toBe(expectedActive);
    });

    it.each([
      {
        label: 'pagination ignored',
        qs: 'st=done',
        current: { status: ['done'], page: 2, pageSize: 50 },
      },
      {
        label: 'multivalue order/dedup',
        qs: 'st=review,done',
        current: { status: ['done', 'review'] },
      },
    ] as const)('recognizes active filter with $label', ({ qs, current }) => {
      expect(
        isFilterActive({ id: '1', name: 'Test', qs }, { ...current, status: [...current.status] }),
      ).toBe(true);
    });
  });
});
