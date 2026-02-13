/**
 * Documentation Registry
 *
 * Central registry for all documentation files. Imports markdown files,
 * parses frontmatter, and provides lookup functions.
 *
 * Uses defensive parsing to prevent malformed docs from crashing the app.
 */

import codeReviewRaw from './guides/code-review.md?raw';
import chatRaw from './guides/chat.md?raw';
import { parseFrontmatter, type DocEntry, type DocCategory } from '@/ui/lib/docs';

/**
 * Safely parse a documentation file, returning null if parsing fails.
 * Logs a warning for malformed documents but doesn't crash the app.
 */
function safeParseFrontmatter(raw: string, docName: string): DocEntry | null {
  try {
    return parseFrontmatter(raw);
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[docs] Failed to parse frontmatter for "${docName}":`, err);
    }
    return null;
  }
}

/**
 * Raw doc imports with their names for error reporting
 */
const RAW_DOCS: Array<{ raw: string; name: string }> = [
  { raw: codeReviewRaw, name: 'guides/code-review.md' },
  { raw: chatRaw, name: 'guides/chat.md' },
];

/**
 * Registry of all documentation entries
 * Malformed docs are skipped with a warning logged
 */
export const DOCS_REGISTRY: DocEntry[] = RAW_DOCS.map(({ raw, name }) =>
  safeParseFrontmatter(raw, name),
).filter((entry): entry is DocEntry => entry !== null);

/**
 * Look up a documentation entry by its slug
 */
export function getDocBySlug(slug: string): DocEntry | undefined {
  return DOCS_REGISTRY.find((doc) => doc.slug === slug);
}

/**
 * Get all documentation entries for a specific category
 */
export function getDocsByCategory(category: DocCategory): DocEntry[] {
  return DOCS_REGISTRY.filter((doc) => doc.frontmatter.category === category);
}
