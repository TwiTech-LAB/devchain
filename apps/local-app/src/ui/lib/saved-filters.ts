/**
 * LocalStorage CRUD utilities for saved board filters.
 *
 * Storage key pattern: devchain:board:savedFilters:${projectId}
 */

export interface SavedFilter {
  id: string; // UUID
  name: string; // User-defined, unique per project
  qs: string; // Canonical query string from serializeBoardFilters()
}

const STORAGE_KEY_PREFIX = 'devchain:board:savedFilters';

/**
 * Get the localStorage key for a project's saved filters.
 */
function getStorageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}:${projectId}`;
}

/**
 * Get all saved filters for a project.
 * Returns empty array if no filters exist or on parse error.
 */
export function getSavedFilters(projectId: string): SavedFilter[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const key = getStorageKey(projectId);
    const stored = window.localStorage.getItem(key);
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored);
    // Validate array structure
    if (!Array.isArray(parsed)) {
      console.warn('Invalid saved filters data: expected array');
      return [];
    }
    // Basic validation of each item
    return parsed.filter(
      (item): item is SavedFilter =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.qs === 'string',
    );
  } catch (error) {
    console.error('Failed to load saved filters', error);
    return [];
  }
}

/**
 * Save filters to localStorage.
 */
function persistFilters(projectId: string, filters: SavedFilter[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const key = getStorageKey(projectId);
    window.localStorage.setItem(key, JSON.stringify(filters));
  } catch (error) {
    console.error('Failed to save filters', error);
  }
}

/**
 * Check if a filter name already exists for a project (case-insensitive).
 */
export function filterNameExists(projectId: string, name: string): boolean {
  const filters = getSavedFilters(projectId);
  const normalizedName = name.trim().toLowerCase();
  return filters.some((f) => f.name.trim().toLowerCase() === normalizedName);
}

/**
 * Save a new filter. Validates unique name.
 * @throws Error if name already exists
 */
export function saveFilter(projectId: string, name: string, qs: string): SavedFilter {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Filter name cannot be empty');
  }

  if (filterNameExists(projectId, trimmedName)) {
    throw new Error(`A filter named "${trimmedName}" already exists`);
  }

  const filters = getSavedFilters(projectId);
  const newFilter: SavedFilter = {
    id: crypto.randomUUID(),
    name: trimmedName,
    qs,
  };

  filters.push(newFilter);
  persistFilters(projectId, filters);

  return newFilter;
}

/**
 * Rename an existing filter.
 * @throws Error if filter not found or new name already exists
 */
export function renameFilter(projectId: string, filterId: string, newName: string): void {
  const trimmedName = newName.trim();
  if (!trimmedName) {
    throw new Error('Filter name cannot be empty');
  }

  const filters = getSavedFilters(projectId);
  const filterIndex = filters.findIndex((f) => f.id === filterId);

  if (filterIndex === -1) {
    throw new Error('Filter not found');
  }

  // Check if new name conflicts with another filter (not the same one)
  const normalizedNewName = trimmedName.toLowerCase();
  const conflict = filters.some(
    (f, idx) => idx !== filterIndex && f.name.trim().toLowerCase() === normalizedNewName,
  );

  if (conflict) {
    throw new Error(`A filter named "${trimmedName}" already exists`);
  }

  filters[filterIndex] = { ...filters[filterIndex], name: trimmedName };
  persistFilters(projectId, filters);
}

/**
 * Delete a filter by ID.
 * No-op if filter not found.
 */
export function deleteFilter(projectId: string, filterId: string): void {
  const filters = getSavedFilters(projectId);
  const newFilters = filters.filter((f) => f.id !== filterId);

  if (newFilters.length !== filters.length) {
    persistFilters(projectId, newFilters);
  }
}

/**
 * Update a filter's query string.
 * @throws Error if filter not found
 */
export function updateFilterQuery(projectId: string, filterId: string, qs: string): void {
  const filters = getSavedFilters(projectId);
  const filterIndex = filters.findIndex((f) => f.id === filterId);

  if (filterIndex === -1) {
    throw new Error('Filter not found');
  }

  filters[filterIndex] = { ...filters[filterIndex], qs };
  persistFilters(projectId, filters);
}

/**
 * Get a single filter by ID.
 * Returns undefined if not found.
 */
export function getFilterById(projectId: string, filterId: string): SavedFilter | undefined {
  const filters = getSavedFilters(projectId);
  return filters.find((f) => f.id === filterId);
}
