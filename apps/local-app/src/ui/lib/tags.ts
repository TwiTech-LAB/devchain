/**
 * Utilities for working with tags and facets
 */

export interface TagFacet {
  key: string;
  values: Map<string, number>; // value -> count
}

export interface ParsedTag {
  original: string;
  key: string | null;
  value: string | null;
  isKeyValue: boolean;
}

/**
 * Parse a tag string into key and value components
 */
export function parseTag(tag: string): ParsedTag {
  const colonIndex = tag.indexOf(':');

  if (colonIndex === -1 || colonIndex === 0 || colonIndex === tag.length - 1) {
    // Simple label tag (no colon, or invalid key:value format)
    return {
      original: tag,
      key: null,
      value: null,
      isKeyValue: false,
    };
  }

  return {
    original: tag,
    key: tag.substring(0, colonIndex),
    value: tag.substring(colonIndex + 1),
    isKeyValue: true,
  };
}

/**
 * Extract facets from a list of tags
 * Returns a map of facet keys to their values and counts
 */
export function extractFacets(tags: string[]): Map<string, TagFacet> {
  const facetsMap = new Map<string, TagFacet>();
  const LABELS_KEY = '__labels__';

  tags.forEach((tag) => {
    const parsed = parseTag(tag);

    if (parsed.isKeyValue && parsed.key && parsed.value) {
      // Key:value tag
      if (!facetsMap.has(parsed.key)) {
        facetsMap.set(parsed.key, {
          key: parsed.key,
          values: new Map(),
        });
      }

      const facet = facetsMap.get(parsed.key)!;
      const currentCount = facet.values.get(parsed.value) ?? 0;
      facet.values.set(parsed.value, currentCount + 1);
    } else {
      // Simple label tag
      if (!facetsMap.has(LABELS_KEY)) {
        facetsMap.set(LABELS_KEY, {
          key: LABELS_KEY,
          values: new Map(),
        });
      }

      const facet = facetsMap.get(LABELS_KEY)!;
      const currentCount = facet.values.get(tag) ?? 0;
      facet.values.set(tag, currentCount + 1);
    }
  });

  return facetsMap;
}

/**
 * Extract all unique tags from a list of documents
 */
export function extractAllTags<T extends { tags: string[] }>(documents: T[]): string[] {
  const tagsSet = new Set<string>();
  documents.forEach((doc) => {
    doc.tags.forEach((tag) => tagsSet.add(tag));
  });
  return Array.from(tagsSet).sort();
}

/**
 * Get the display name for a facet key
 */
export function getFacetDisplayName(key: string): string {
  if (key === '__labels__') {
    return 'Labels';
  }
  // Capitalize first letter and replace hyphens/underscores with spaces
  return key
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Group documents by a facet key
 */
export function groupDocumentsByFacet<T extends { tags: string[] }>(
  documents: T[],
  facetKey: string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  const UNGROUPED_KEY = '__ungrouped__';

  documents.forEach((doc) => {
    let assigned = false;

    doc.tags.forEach((tag) => {
      const parsed = parseTag(tag);

      if (facetKey === '__labels__' && !parsed.isKeyValue) {
        // Group by label
        if (!groups.has(tag)) {
          groups.set(tag, []);
        }
        groups.get(tag)!.push(doc);
        assigned = true;
      } else if (parsed.isKeyValue && parsed.key === facetKey && parsed.value) {
        // Group by key:value
        if (!groups.has(parsed.value)) {
          groups.set(parsed.value, []);
        }
        groups.get(parsed.value)!.push(doc);
        assigned = true;
      }
    });

    if (!assigned) {
      if (!groups.has(UNGROUPED_KEY)) {
        groups.set(UNGROUPED_KEY, []);
      }
      groups.get(UNGROUPED_KEY)!.push(doc);
    }
  });

  return groups;
}

/**
 * Check if a document matches the selected facets
 */
export function documentMatchesFacets<T extends { tags: string[] }>(
  document: T,
  selectedFacets: Map<string, Set<string>>,
): boolean {
  if (selectedFacets.size === 0) {
    return true;
  }

  // Document must have at least one value from each selected facet key
  for (const [facetKey, selectedValues] of selectedFacets.entries()) {
    if (selectedValues.size === 0) {
      continue;
    }

    let hasMatch = false;

    if (facetKey === '__labels__') {
      // Check if document has any of the selected label tags
      for (const tag of document.tags) {
        const parsed = parseTag(tag);
        if (!parsed.isKeyValue && selectedValues.has(tag)) {
          hasMatch = true;
          break;
        }
      }
    } else {
      // Check if document has any of the selected key:value pairs
      for (const tag of document.tags) {
        const parsed = parseTag(tag);
        if (parsed.isKeyValue && parsed.key === facetKey && parsed.value) {
          if (selectedValues.has(parsed.value)) {
            hasMatch = true;
            break;
          }
        }
      }
    }

    if (!hasMatch) {
      return false;
    }
  }

  return true;
}

/**
 * Build a tags array from selected facets for API queries
 */
export function facetsToTagsArray(selectedFacets: Map<string, Set<string>>): string[] {
  const tags: string[] = [];

  for (const [facetKey, selectedValues] of selectedFacets.entries()) {
    for (const value of selectedValues) {
      if (facetKey === '__labels__') {
        tags.push(value);
      } else {
        tags.push(`${facetKey}:${value}`);
      }
    }
  }

  return tags;
}
